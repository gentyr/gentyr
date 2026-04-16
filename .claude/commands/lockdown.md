<!-- HOOK:GENTYR:lockdown -->
# /lockdown - Toggle Deputy-CTO Console Lockdown

Toggles the interactive session lockdown via MCP tools. When lockdown is **enabled** (default),
interactive Claude Code sessions operate as the deputy-CTO console: only read/observe
tools are available. File-editing tools (Edit, Write, NotebookEdit) and code-modifying
sub-agents are blocked.

**Disabling lockdown requires the CTO to type APPROVE BYPASS <code> in chat — the HMAC-signed token is the only real authorization.**

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Usage

- `/lockdown` — Show current lockdown status
- `/lockdown on` — Enable the deputy-CTO lockdown (default)
- `/lockdown off` — Disable the lockdown (requires APPROVE BYPASS token, blocked for spawned sessions)

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

Disabling lockdown requires CTO approval via the APPROVE BYPASS flow — the agent
cannot forge this because the code is server-generated and the approval token is
HMAC-signed with `.claude/protection-key`.

**Step 1: Request bypass code**

Call `mcp__deputy-cto__request_bypass({ reason: 'Disable interactive session lockdown', reporting_agent: 'cto-interactive', blocked_by: 'interactive-lockdown-guard' })`.

The tool returns a 6-char code (e.g., `K7N9M3`). Display it to the CTO:

    To disable lockdown, type this in chat: APPROVE BYPASS K7N9M3

**Step 2: CTO types the approval**

The CTO types `APPROVE BYPASS <code>` in chat. This triggers `bypass-approval-hook.js`,
which validates the code against deputy-cto.db and writes an HMAC-signed token
to `.claude/bypass-approval-token.json` (5-min expiry, one-time use).

**Step 3: Call set_lockdown_mode**

After the CTO confirms the approval was accepted, call `mcp__agent-tracker__set_lockdown_mode({ enabled: false })`.

The MCP tool verifies the HMAC token (using `.claude/hooks/lib/bypass-approval-token.js`),
consumes it, and disables lockdown.

Display confirmation:

    Deputy-CTO Console Lockdown: DISABLED

    WARNING: This is intended for development/debugging only.
    All tools are now available in this interactive session.
    A [LOCKDOWN DISABLED] warning will be injected on every tool call.
    Run /lockdown on to re-enable standard GENTYR workflow.

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
- Disabling requires the HMAC-signed APPROVE BYPASS token — the agent physically cannot forge it
