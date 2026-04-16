<!-- HOOK:GENTYR:lockdown -->
# /lockdown - Toggle Deputy-CTO Console Lockdown

Toggles the interactive session lockdown via MCP tools. When lockdown is **enabled** (default),
interactive Claude Code sessions operate as the deputy-CTO console: only read/observe
tools are available. File-editing tools (Edit, Write, NotebookEdit) and code-modifying
sub-agents are blocked.

**Disabling lockdown creates an audit record in the CTO bypass request system. Spawned sessions are blocked server-side.**

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Usage

- `/lockdown` — Show current lockdown status
- `/lockdown on` — Enable the deputy-CTO lockdown (default)
- `/lockdown off` — Disable the lockdown (creates audit record, blocked for spawned sessions)

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

Call `mcp__agent-tracker__set_lockdown_mode({ enabled: false })`.

Disabling lockdown creates an auto-approved record in bypass-requests.db as an audit trail.
The MCP tool server-side blocks spawned sessions from calling this — only interactive CTO sessions can disable.

Display confirmation:
```
Deputy-CTO Console Lockdown: DISABLED

WARNING: This is intended for development/debugging only.
All tools are now available in this interactive session.
A [LOCKDOWN DISABLED] warning will be injected on every tool call.
Run /lockdown on to re-enable standard GENTYR workflow.
```

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

## Important

- This does NOT require a session restart — takes effect immediately
- The setting persists across sessions (stored in `automation-config.json`)
- Re-enabling is always safe and recommended after debugging
- Disabling creates an audit record in bypass-requests.db and is blocked server-side for spawned sessions
