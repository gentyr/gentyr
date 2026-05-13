<!-- HOOK:GENTYR:lockdown -->
# /lockdown - Toggle Deputy-CTO Console Lockdown

Toggles the interactive session lockdown via MCP tools. When lockdown is **enabled** (default),
interactive Claude Code sessions operate as the deputy-CTO console: only read/observe
tools are available. File-editing tools (Edit, Write, NotebookEdit) and code-modifying
sub-agents are blocked.

**Disabling lockdown requires CTO authorization via the Unified CTO Authorization System — verbatim approval + independent auditor verification.**

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
1. Verify the CTO's text exists in the session JSONL (tamper-proof)
2. Spawn an independent authorization auditor to verify intent
3. Auto-execute the lockdown disable after audit pass

Display confirmation once the decision is recorded:

    Deputy-CTO Console Lockdown: DISABLE PENDING

    Your approval has been recorded and an independent auditor is verifying.
    Lockdown will be disabled automatically after audit pass (usually seconds).
    Check status with /lockdown.

Do NOT retry `set_lockdown_mode` -- the deferred action system handles execution autonomously.

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
- Disabling requires CTO authorization (verbatim approval + independent auditor) — the agent physically cannot forge a CTO decision
