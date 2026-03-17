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

Root-owned critical hook files prevent agent modification. Tamper detection uses symlink target verification and file ownership checks at both commit-time and session-start. `protection-state.json` records the critical hooks list.

> Full details: [Protection Security Model](docs/CLAUDE-REFERENCE.md#protection-security-model)

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

In target projects, GENTYR enforces a 4-stage merge chain: `feature/* -> preview -> staging -> main`. Direct commits to `main`, `staging`, and `preview` are blocked at the local level via pre-commit and pre-push hooks. Only promotion pipeline agents (`GENTYR_PROMOTION_PIPELINE=true`) may operate on protected branches.

### Feature Branch Commit Flow (Self-Merge)

Agents work on feature branches (`feature/*`, `fix/*`, `refactor/*`, `docs/*`, `chore/*`). At commit time, only lint and security checks run — no deputy-CTO review gate. This keeps commit latency low.

**Branch Age Guard** (`pre-commit-review.js`): Blocks commits on feature branches when the last branch-specific commit is older than the configured limit (default 4 hours). Measures from the most recent commit on the branch (not the merge-base) to avoid deadlocks on interrupted sessions. First commits on a branch are always allowed (no commits to measure against). Merge resolution commits (`MERGE_HEAD` present) are exempt from the age check. The limit is configurable via `branch_age_limit_hours` in `.claude/state/automation-config.json`. Non-fatal: if branch age cannot be determined, the commit is allowed.

After committing, the project-manager agent:
1. Pushes the branch: `git push -u origin HEAD`
2. Creates a PR to the appropriate base branch (`preview` in target projects, `main` in the gentyr repo): `gh pr create --base <base> --head <branch> --title "..."`
3. **Self-merges immediately**: `gh pr merge <number> --squash --delete-branch`
4. Cleans up the worktree and local branch

Code review happens at promotion time (preview -> staging), not at the feature branch level.

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

Concurrent agents work in isolated git worktrees at `.claude/worktrees/<branch>/`. Each worktree is provisioned with symlinked GENTYR config (hooks, agents, commands) and a worktree-specific `.mcp.json` with absolute `CLAUDE_PROJECT_DIR` paths. Worktrees for merged branches are cleaned up every **30 minutes** by the hourly automation (`getCooldown('worktree_cleanup', 30)`). The project-manager is responsible for cleaning up worktrees immediately after self-merge; the 30-minute automation is a safety net for missed cleanups.

**Abandoned worktree rescue**: `rescueAbandonedWorktrees()` in `hourly-automation.js` detects worktrees that have uncommitted changes but no active agent process, then spawns a project-manager to commit, push, and merge the orphaned work. Runs every **30 minutes** (`getCooldown('abandoned_worktree_rescue', 30)`).

**Active session protection**: `cleanupMergedWorktrees()` in `worktree-manager.js` uses `isWorktreeInUse()` (`lsof +D`) to detect open file descriptors before removing a worktree. Worktrees with active processes are skipped to prevent CWD eviction of live sessions. The `worktree-cwd-guard.js` hook additionally detects stale CWD at tool-call time and blocks Bash execution with a recovery hint if the worktree directory no longer exists.

**Deferred fetch** (`skipFetch` option): `createWorktree()` accepts `{ skipFetch: true }` to skip the `git fetch origin` step, reducing worktree creation latency from 3-8s to under 1 second. Used by `force-spawn-tasks.js` when the caller has already ensured remote refs are up to date. Not recommended for cold-start provisioning where the base branch ref may be stale.

`core.hooksPath` poisoning is defended by 4 layers (removeWorktree, tamperCheck, husky pre-commit, safeSymlink EINVAL fix).

> Full details: [Worktrees core.hooksPath Poisoning Defense](docs/CLAUDE-REFERENCE.md#worktrees-corehookspath-poisoning-defense)

### Sub-Agent Working Tree Isolation

Code-modifying sub-agents (`code-reviewer`, `code-writer`, `test-writer`) MUST be spawned with `isolation: "worktree"` when using the `Task` tool. This gives them their own branch and working directory, isolating their file changes from the main tree and other concurrent agents.

**Base branch**: Agent worktrees branch from the project's base branch — `preview` in target projects, `main` in the gentyr repo. `createWorktree()` auto-detects by checking if `origin/preview` exists; if not, falls back to `origin/main`. It creates a NEW unique branch (e.g., `feature/code-review-abc`) based on the detected base — it does NOT check out the base branch itself. Multiple agents can all branch from the base concurrently without conflict.

**Why**: Without worktree isolation, sub-agents share the parent session's working tree. Concurrent file edits from multiple agents cause conflicts, and any git operation (stash, reset) in the main tree can destroy all agents' uncommitted work.

**Enforcement**: `main-tree-commit-guard.js` hard-blocks `git add`/`git commit`/`git reset --hard`/`git stash`/`git clean`/`git pull` for spawned agents (`CLAUDE_SPAWNED_SESSION=true`) in the main tree as a safety net.

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

By default, the automation service runs without 1Password credentials in background mode to avoid macOS permission prompts. Provide `--op-token` with a 1Password service account token to enable headless credential resolution for infrastructure MCP servers.

### On-Demand Task Spawning

```bash
# In a Claude Code session after GENTYR is installed:
/spawn-tasks
```

Unified agent spawning command with two modes:

- **Bare mode** (`/spawn-tasks`): Browse pending tasks by section and spawn them immediately
- **Description mode** (`/spawn-tasks <description>`): Create new tasks from plain English, then spawn

Bypasses the hourly automation's age filter, batch limit, cooldowns, and CTO activity gate. Prefetches current agent counts and concurrency limits. Uses `force_spawn_tasks` on the agent-tracker MCP server with optional `taskIds` for targeted spawning, and `monitor_agents` to poll spawned agent status. Preserves the concurrency guard and task status tracking.

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

**Race condition prevention**: `urgent-task-spawner.js` (Universal Task Spawner v2.0.0) checks quota-zone gating on the input side — urgent tasks always spawn, normal tasks are gated by API quota utilization (green/yellow/red zones); `task-gate-spawner.js` checks `tool_response.status === 'pending_review'` (output-side). No overlap.

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

GENTYR automatically detects and recovers sessions interrupted by API quota limits, unexpected process death, or full account exhaustion. Three revival modes: (1) quota-interrupted sessions, (2) dead session recovery, (3) paused sessions. Dead Agent Recovery Hook runs at SessionStart; Session Reviver runs every 10 minutes from hourly automation.

**Inline revival** (Phase 1): When quota rotation succeeds inside the stop hook, `stop-continue-hook.js` spawns `claude --resume` immediately — reducing revival latency from 5-15 minutes to 0-2 seconds. A safety-net record is written to `quota-interrupted-sessions.json` first so session-reviver picks up if inline revival fails.

**Revival daemon** (`scripts/revival-daemon.js`): Persistent `fs.watch()` + polling daemon for sub-second crash detection. Integrated as a launchd/systemd service via `setup-automation-service.sh`.

**Memory pressure rate limiting** (`lib/memory-pressure.js`): Shared module monitoring free RAM (macOS `vm_stat` / Linux `/proc/meminfo`). Blocks all spawning at critical pressure; defers non-urgent spawning at high pressure. Used by stop hook, session reviver, universal task spawner, and hourly automation.

> Full details: [Automatic Session Recovery](docs/CLAUDE-REFERENCE.md#automatic-session-recovery)

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

## Hooks Reference

Individual hook specifications for all GENTYR hooks (auto-sync, CTO notification, branch drift, branch checkout guard, main tree commit guard, uncommitted change monitor, PR auto-merge nudge, project-manager reminder, credential health check, credential file guard, playwright CLI guard, playwright health check, worktree path guard, worktree CWD guard, interactive agent guard).

> Full details: [Hooks Reference](docs/CLAUDE-REFERENCE.md#hooks-reference)

## Playwright MCP Server

The Playwright MCP server (`packages/mcp-servers/src/playwright/`) provides tools for running E2E tests, managing auth state, and launching demos. Uses project-agnostic config discovery from `playwright.config.ts`. Key tools: `launch_ui_mode`, `run_tests`, `run_demo`, `check_demo_result`, `preflight_check`, `run_auth_setup`, `open_video`.

> Full details: [Playwright MCP Server](docs/CLAUDE-REFERENCE.md#playwright-mcp-server)

## Playwright Helpers Package

Shared TypeScript utilities for Playwright-based feedback agents and demo scenarios. Located at `packages/playwright-helpers/`. Published as `@gentyr/playwright-helpers`. Exports helper functions for persona overlay injection, cursor highlighting, tab management (open/switch/close), terminal interaction (type commands, wait for output), and editor interaction (type code, run code). Built to `dist/` (gitignored). Consumed by feedback agents and demo scenario implementations via `@playwright/test` peer dependency.

```bash
cd packages/playwright-helpers && npm run build
```

## Demo Scenario System

Curated product walkthroughs mapped to personas. Managed by product-manager agent, implemented by code-writer agents. Only `gui` and `adk` consumption_mode personas can have scenarios. `*.demo.ts` naming convention enforced.

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

**Window recording via ScreenCaptureKit** (headed demos, macOS only): `run_demo` starts a `WindowRecorder` Swift CLI (`tools/window-recorder/`) alongside the Playwright child. Uses `SCContentFilter(desktopIndependentWindow:)` to capture the specific Chromium window even when occluded or in another Space. The recorder polls for up to 120s for the window to appear, then streams H.264 frames to an MP4 via AVAssetWriter. Window recorder PID and output path are tracked in `DemoRunState` (`window_recorder_pid`, `window_recording_path`). On demo completion, the recording is persisted via `persistScenarioRecording()`; temp files are cleaned up automatically. `stop_demo` and `check_demo_result` also handle window recorder teardown gracefully: SIGINT is sent first; if the process exits cleanly within 10s, the MP4 is persisted; if SIGKILL is required (process did not exit in time), persistence is skipped because SIGKILL prevents AVAssetWriter from writing the moov atom (corrupted MP4). All teardown paths — suite completion, `stop_demo`, crash recovery, and `autoKillDemo` — gate persistence on the recorder's clean exit. `check_demo_result` returns `recording_path` and `recording_source` (`'window' | 'none'`) indicating whether a recording was persisted.

Dev server is auto-started if not running — no manual setup needed.

### Demo Prerequisites

Register setup commands that must run before demos. Prerequisites are idempotent: if a health check passes, the setup command is skipped.

**3 scopes:**
- `global` — runs before all demos
- `persona` — runs before demos for a specific persona
- `scenario` — runs before a specific scenario

**Execution order:** global → persona → scenario, sorted by `sort_order` within each scope.

**Health checks:** Optional verification command. If exit 0, setup command is skipped entirely. For `run_as_background` prerequisites (e.g., dev servers), the health check is polled every 2s until ready or timeout.

**CRUD tools** (on `user-feedback` server): `register_prerequisite`, `update_prerequisite`, `delete_prerequisite`, `list_prerequisites`.

**Execution tool** (on `playwright` server): `run_prerequisites` — automatically called by `run_demo`, `run_demo_batch`, and `preflight_check`.

### Automated Demo Validation

6-hour automated cycle that runs all enabled demo scenarios headless and spawns repair agents for failures.

**Opt-in:** Set `demoValidationEnabled: true` in `.claude/state/automation-config.json`.

**Flow:**
1. Query enabled scenarios from `user-feedback.db`
2. Run global prerequisites
3. Execute each scenario headless (`DEMO_HEADLESS=1, DEMO_SLOW_MO=0`)
4. Persist results to `.claude/state/demo-validation-history.json` (last 100 runs)
5. Spawn `demo-manager` repair agents (max 3) for failures in isolated worktrees
6. Report failures to deputy-CTO via `agent-reports`

ADK-category scenarios are skipped (require replay data). Cooldown: `demo_validation` (default 360 minutes / 6 hours).

### Demo-Manager Agent

Sole authority for demo lifecycle work. Handles prerequisite registration, scenario creation, `.demo.ts` implementation, preflight, execution, video recording, debugging, and repair.

**Rules:** Only modifies `.demo.ts` files and demo configuration. Does NOT commit (project-manager handles git). Other agents (`code-writer`, `test-writer`, `feedback-agent`) are explicitly forbidden from modifying `.demo.ts` files.

## Rotation Proxy

Local MITM proxy on `localhost:18080` for transparent credential rotation. Intercepts `api.anthropic.com` (TLS MITM + header swap); `mcp-proxy.anthropic.com` and everything else passes through as a transparent CONNECT tunnel (MCP proxy uses session-bound OAuth tokens that must not be swapped). Within MITM'd requests, only paths in `SWAP_PATH_PREFIXES` (`/v1/messages`, `/v1/organizations`, `/api/event_logging/`, `/api/eval/`, `/api/web/`) get the Authorization header swapped — OAuth and session-health paths pass through unchanged to prevent token revocation. Handles 429 retry with automatic key rotation. Runs as a launchd KeepAlive service. Enable/disable via `npx gentyr proxy enable|disable`.

> Full details: [Rotation Proxy](docs/CLAUDE-REFERENCE.md#rotation-proxy)

### Proxy Audit Trail

Structured JSON log at `~/.claude/rotation-proxy.log`. 24h retention (auto-cleaned hourly). 10MB safety cap.

**Key events for debugging:**
| Event | When | Key Fields |
|-------|------|------------|
| `tunnel_passthrough` | CONNECT for non-MITM host | `host`, `port` |
| `tunnel_established` | Upstream TCP connected | `host`, `port`, `head_bytes` |
| `tunnel_closed` | Tunnel ended | `host`, `duration_ms`, `bytes_from_server`, `bytes_from_client`, `closed_by` |
| `tunnel_error` | Upstream connect failed | `host`, `error`, `duration_ms` |
| `tunnel_client_error` | Client socket error | `host`, `error`, `duration_ms` |
| `mitm_intercept` | CONNECT for MITM host | `host`, `port` |
| `request_intercepted` | MITM request forwarded | `host`, `method`, `path`, `active_key_id` |
| `response_received` | MITM response status | `host`, `status`, `is_sse`, `active_key_id` |
| `rotating_on_429` | Key exhausted | `host`, `exhausted_key_id`, `retry` |
| `rotating_on_401` | Auth failure rotation | `host`, `failed_key_id`, `retry` |
| `session_path_passthrough` | Path not in swap allowlist (OAuth, session-health, etc.) | `host`, `method`, `path`, `incoming_key_id`, `active_key_id` |
| `tombstone_token_swap` | Incoming token is tombstoned — swapping to active key | `host`, `method`, `path`, `incoming_key_id`, `active_key_id` |
| `merged_token_swap` | Incoming token is merged/deduped — swapping to active key | `host`, `method`, `path`, `incoming_key_id`, `merged_into`, `active_key_id` |
| `force_swap_override` | forceSwap prevented passthrough on non-SWAP path (merged/tombstone token) | `host`, `method`, `path`, `incoming_key_id`, `active_key_id`, `reason` |
| `dead_active_key_passthrough` | Active key is dead — incoming token passed through unchanged | `host`, `method`, `path`, `incoming_key_id`, `active_key_id`, `active_status` |

**Debug workflow:**
1. `grep 'tunnel_error\|tunnel_client_error' ~/.claude/rotation-proxy.log` — find broken tunnels
2. `grep 'mcp-proxy' ~/.claude/rotation-proxy.log | tail -20` — check MCP proxy connections
3. `grep 'rotating_on_' ~/.claude/rotation-proxy.log` — find rotation cascades
4. `grep 'tunnel_closed.*mcp-proxy' ~/.claude/rotation-proxy.log` — check tunnel lifecycle (duration, bytes)

## Chrome Browser Automation

The chrome-bridge MCP server provides 18 tools for browser automation via Claude for Chrome extension. Communicates via local Unix domain socket — no credentials required.

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

The secret-sync MCP server orchestrates secrets from 1Password to deployment platforms without exposing values to agent context. 6 tools available. Secret values never pass through agent context window.

> Full details: [Secret Management](docs/CLAUDE-REFERENCE.md#secret-management)

## Icon Processor MCP Server

The icon-processor MCP server provides 12 tools for sourcing, downloading, processing, and storing brand/vendor icons into clean square SVG format. Consumed by the `icon-finder` agent. Global icon store at `~/.claude/icons/`.

> Full details: [Icon Processor MCP Server](docs/CLAUDE-REFERENCE.md#icon-processor-mcp-server)

## Plan Orchestrator MCP Server

The plan-orchestrator MCP server (`packages/mcp-servers/src/plan-orchestrator/`) manages structured execution plans with phases, tasks, substeps, dependencies, and cross-DB integration with `todo.db`. State is in `.claude/state/plans.db` (SQLite, WAL mode). Tier 2 (stateful, per-session stdio).

**17 tools**: `create_plan`, `get_plan`, `list_plans`, `update_plan_status`, `add_phase`, `update_phase`, `add_plan_task`, `update_task_progress`, `link_task`, `add_substeps`, `complete_substep`, `add_dependency`, `get_spawn_ready_tasks`, `plan_dashboard`, `plan_timeline`, `plan_audit`, `plan_sessions`.

**6-table SQLite schema**: `plans`, `phases`, `plan_tasks`, `substeps`, `dependencies`, `state_changes`. Cycle detection on dependency graph. Progress rollup from substep → task → phase → plan.

**Cross-DB integration**: `add_plan_task` optionally creates a corresponding `todo.db` task and links them via `todo_task_id`. `plan-merge-tracker.js` hook detects `gh pr merge` calls (PostToolUse Bash) and auto-advances linked plan tasks to `completed`, then cascades `ready` status to unblocked dependents.

**3 hooks registered in `settings.json.template`**:
- `plan-briefing.js` (SessionStart) — briefs the active session on current plan state
- `plan-work-tracker.js` (PostToolUse `summarize_work`) — records agent work against plan tasks
- `plan-merge-tracker.js` (PostToolUse Bash) — detects PR merges and auto-completes plan tasks

**5 slash commands**: `/plan`, `/plan-progress`, `/plan-timeline`, `/plan-audit`, `/plan-sessions`.

**CTO Dashboard integration**: 5 sections (`plans`, `plan-progress`, `plan-timeline`, `plan-audit`, `plan-sessions`) rendered via `PlanSection`, `PlanProgressSection`, `PlanTimelineSection`, `PlanAuditSection`, `PlanSessionSection` components. Data read from `plans.db` via `packages/cto-dashboard/src/utils/plan-reader.ts`; session correlation data from 7 sources via `packages/cto-dashboard/src/utils/plan-session-reader.ts`.

All 3 hooks are in the `criticalHooks` list in `cli/commands/protect.js` and are root-owned when protection is enabled.

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports `--mock` for development and `--page N` to split rendering across 3 pages. `/cto-report` runs all three pages. Includes WORKLOG system for agent work tracking via `summarize_work` tool.

> Full details: [CTO Dashboard Development](docs/CLAUDE-REFERENCE.md#cto-dashboard-development)
