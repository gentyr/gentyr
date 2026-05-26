<!-- HOOK:GENTYR:lockdown -->
# /lockdown - Toggle Deputy-CTO Console Lockdown

Toggles the interactive session lockdown via MCP tools. When lockdown is **enabled** (default),
interactive Claude Code sessions operate as the deputy-CTO console: only read/observe
tools are available. File-editing tools (Edit, Write, NotebookEdit) and code-modifying
sub-agents are blocked.

**Disabling lockdown requires CTO authorization via the Unified CTO Authorization System — verbatim approval recorded in the session JSONL. `lockdown_toggle` decisions execute inline via the `authorization-audit-spawner.js` PostToolUse hook — no auditor is spawned (interactive sessions have no `agent_id`/`queue_id` for `peek_session` to look up, and the JSONL quote verification in `record_cto_decision` is sufficient proof on its own).**

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Usage

- `/lockdown` — Show current lockdown status
- `/lockdown on` — Enable the deputy-CTO lockdown (default)
- `/lockdown off` — Disable the lockdown (requires CTO authorization, blocked for spawned sessions)

## Step 1: Determine the Argument

Parse the argument after `/lockdown`:
- No argument → **Status Only** mode
- `on` → **Enable** lockdown
- `off` → **Disable** lockdown
- Any other argument → Show error and print usage

## Status Only Mode (no argument)

Call `mcp__agent-tracker__get_lockdown_mode()` and display the result.

## Enable Lockdown (/lockdown on)

Call `mcp__agent-tracker__set_lockdown_mode({ enabled: true })`.

Display confirmation:
```
Deputy-CTO Console Lockdown: ENABLED

Interactive sessions now operate as the deputy-CTO console.
File-editing and sub-agent tools are restricted.
This takes effect immediately for new tool calls.
```

## Disable Lockdown (/lockdown off)

Disabling lockdown requires CTO authorization via the Unified CTO Authorization System.
The agent cannot forge this because the deferred action is HMAC-signed and an independent
auditor verifies the CTO's intent from the session JSONL.

**Step 1: Request lockdown disable**

Call `mcp__agent-tracker__set_lockdown_mode({ enabled: false })`.

The tool returns a deferred action ID. Display the request to the CTO:

    To disable lockdown, please confirm by typing your approval (e.g., "yes, disable lockdown").

**Step 2: Record CTO decision**

After the CTO types their approval in chat, call:

```
mcp__agent-tracker__record_cto_decision({
  decision_type: "lockdown_toggle",
  decision_id: "<deferred_action_id from step 1>",
  verbatim_text: "<CTO's exact words>"
})
```

The system will:
1. Verify the CTO's verbatim text exists in the session JSONL (tamper-proof, HMAC-bound to the session file)
2. The `record_cto_decision` server marks the decision `verified` and returns to you
3. The `authorization-audit-spawner.js` PostToolUse hook fires *immediately* on that return
4. Because `decision_type === "lockdown_toggle"`, the hook hits the `INLINE_EXECUTE_TYPES` branch — it does NOT spawn an auditor
5. The hook directly writes `automation-config.json` (`interactiveLockdownDisabled: true`), provisions a per-session `cto-interactive-<sid8>` worktree, marks the deferred action `completed`, and marks the CTO decision `audit_passed`

This whole chain takes under a second. There is no auditor session, no polling cycle, no audit queue.

**Do NOT** call `ScheduleWakeup`, sleep loops, or repeated `check_cto_decision` polls. The next tool call after `record_cto_decision` returns will see the new lockdown state — just retry whatever the user originally asked for.

Display confirmation once the decision is recorded:

    Deputy-CTO Console Lockdown: DISABLED

    Your approval has been recorded and the lockdown is now off.
    A CTO worktree has been provisioned at <ctoWorktreePath> for safe editing.
    Proceeding with the original request.

Then immediately retry the user's original blocked action (Edit, Write, Task spawn, etc.). Do NOT wait, do NOT poll, do NOT retry `set_lockdown_mode` — the deferred action system executed it inline.

## What the Lockdown Controls

**Blocked in interactive sessions when lockdown is enabled:**
- `Edit` — file editing
- `Write` — file creation
- `NotebookEdit` — notebook editing
- `Agent` / `Task` — code-modifying sub-agent spawning (read-only agents still allowed)
- Bash write commands — git checkout, builds, file mutations

**Always allowed regardless of lockdown:**
- `Read`, `Glob`, `Grep` — code reading
- `Bash` — read-only shell commands (git log, git status, git diff, gh pr list, etc.)
- `WebFetch`, `WebSearch` — external reference
- `AskUserQuestion` — CTO interaction
- `Skill`, `ToolSearch` — slash commands and tool discovery
- All `mcp__*` tools — GENTYR's agent and task management system

**Spawned sessions** (`CLAUDE_SPAWNED_SESSION=true`) are always unrestricted.

**Still blocked when lockdown is OFF** (lockdown-off does NOT disable these — they have separate guards):
- `Write` / `Edit` / `NotebookEdit` to main-tree files (only `.claude/worktrees/`, `.claude/`, `~/.claude/` paths allowed)
- Bash git mutations in the main tree (`git stash`, `checkout`, `switch`, `merge`, `pull`, `rebase`, `reset`, `clean`, `add`, `commit`, `push`, `worktree remove`)
- `--no-verify`, `-n`, `--no-gpg-sign`, `core.hooksPath` writes (block-no-verify guard)
- Main-tree commits on protected branches `main`/`staging`/`preview` (main-tree-commit-guard)

These restrictions exist to prevent conflicts with running agents and to enforce the merge chain. They are NOT controllable via `/lockdown`. The recovery path when blocked is always: `cd` into the CTO worktree and re-run the command there.

## How to Merge CTO Worktree Work (lockdown-OFF mode)

When the CTO has made edits in `ctoWorktreePath` and wants to merge, run these EXACT Bash commands from the worktree. Each must be its own Bash call (CWD persists per call) OR chained with `&&` in one call:

```bash
cd <ctoWorktreePath>
git status                # verify changes
git add -A                # OR git add <specific files>
git commit -m "feat: <description>"   # pre-commit hooks run lint
git push -u origin HEAD   # creates remote branch
gh pr create --base preview --title "..." --body "..."
gh pr checks <num> --watch --fail-fast
gh pr merge <num> --squash --delete-branch
```

**Do NOT use `Agent(subagent_type='project-manager')` for this.** The built-in `Agent` tool creates a NEW worktree separate from `ctoWorktreePath`, so the project-manager would not see any of the CTO's in-progress edits. The merge would target an empty branch.

**Do NOT use `create_task` + `force_spawn_tasks` for this either.** Task-spawned agents work in fresh worktrees provisioned by GENTYR — same problem.

The Bash sequence above is the only correct path. All git mutations are allowed when CWD is inside `.claude/worktrees/` (verified by `interactive-lockdown-guard.js`).

After merge, the CTO worktree can be removed and lockdown re-enabled:
```bash
git -C <PROJECT_DIR> worktree remove <ctoWorktreePath>
# Then in Claude Code: /lockdown on
```

## Rescuing committed work stuck in the main tree

If you (or a prior session) committed work to a feature branch directly in the main tree and now `git push` is blocked by the lockdown-off main-tree guard, **do NOT toggle `/lockdown on` as a remedy** — toggling lockdown does NOT change main-tree git permissions, does NOT enable any new task-spawning capability, and does NOT make pushes possible. The block is enforced by `interactive-lockdown-guard.js` and is INDEPENDENT of lockdown state. Three correct recovery paths:

**1. Push the named branch from any worktree cwd.** The branch ref lives in the shared `.git/refs/heads/` directory, so any worktree on the same repo can push it by name. From your cto-interactive worktree (or any other `.claude/worktrees/*` dir):

```bash
cd <any-worktree-cwd>
git push origin <branch-name>
gh pr create --base preview --head <branch-name> --title "..." --body "..."
gh pr checks <num> --watch --fail-fast
gh pr merge <num> --squash --delete-branch
```

`git push origin HEAD` does NOT work for this purpose because `HEAD` refers to the worktree's current branch, not the branch you committed in the main tree. Always pass the branch by name.

**2. For UNCOMMITTED main-tree work, use `repair_main_tree_drift`.** The `mcp__agent-tracker__repair_main_tree_drift` MCP tool enqueues a rescue agent that salvages orphaned main-tree work to a `rescue/main-tree-<ts>` branch, opens a draft PR, then restores the main tree to the base branch. Never auto-merges, never force-pushes, files a bypass request on conflicts. Idempotent — returns `no_drift` when clean, `already_queued` when a rescue is in flight. Pass `dry_run: true` to preview what it would do without enqueuing.

```
mcp__agent-tracker__repair_main_tree_drift({ dry_run: true })   # preview
mcp__agent-tracker__repair_main_tree_drift()                     # execute
```

**3. For NEW async work, use `/spawn-tasks`.** Each spawned task runs in a freshly provisioned worktree — it does NOT touch your main-tree state. Use this when you want the agent to start from `origin/preview` rather than continuing whatever you committed in the main tree.

**Lockdown is orthogonal to all three of these.** Task spawning (`create_task` + `force_spawn_tasks`) works in BOTH lockdown states. The main-tree git block is its own guard layer; lockdown only controls interactive-session edit/spawn permissions. If you find yourself reasoning "if I just toggle lockdown, the agent could push" — that's wrong. The correct mental model is: lockdown gates the CTO console's tool surface; main-tree git restrictions gate WHERE git mutations can run; task spawning gates whether agents are dispatched. Three independent dials.

## Parallel work in lockdown-off mode

There are two distinct parallelism scenarios and they behave very differently.

**Scenario A (SUPPORTED) — multiple `claude` terminals.** Open several `claude` CLI sessions in separate terminals. Each turns on `/lockdown off` independently and PR #709 provisions a dedicated `cto-interactive-<sid8>` worktree per session, keyed by `session_id` in `automation-config.json#ctoWorktreePaths`. The worktrees are fully isolated — different paths, different branches, different lock IDs. Three or four parallel terminals each running their own 6-step pipeline is the supported pattern for concurrent CTO work.

**Scenario B (NOT SUPPORTED) — fan out parallel Tasks in ONE terminal.** Sending a single message that spawns `Task(subagent_type=..., cwd=<cto-worktree>)` calls A, B, C in parallel collides at step 6 (project-manager). All three sub-agents share the same cwd, and each project-manager runs `git checkout -b feature/X` → commit → push → merge → switch-back. Three concurrent project-managers doing that in the same working tree will trample one another (a real failure showed five branches checked out in one hour, with one code-writer's edits wiped by another pipeline's branch swap).

The project-manager agent defends against Scenario B at step 0 by acquiring an exclusive lock on the worktree (resource id `worktree-<basename>` via `mcp__agent-tracker__acquire_shared_resource`). If a second project-manager finds the lock held, it files a bypass request and exits without touching git, so the CTO sees the collision rather than a silently-corrupted PR. The lock is also a belt — the actual fix is to not fan out Tasks in one terminal.

**Async parallel work (no babysitting):** if you don't need to co-pilot every step, use `/spawn-tasks` or `/persistent-task`. Each task gets its own freshly provisioned worktree (separate from any cto-interactive worktree), runs to completion in the background, and lands its merge automatically. This is the right tool for "three independent things, go do them while I think."

## Important

- This does NOT require a session restart — takes effect immediately
- The setting persists across sessions (stored in `automation-config.json`)
- Re-enabling is always safe and recommended after debugging
- Disabling requires CTO authorization (verbatim approval + independent auditor) — the agent physically cannot forge a CTO decision
