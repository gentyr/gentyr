<!-- HOOK:GENTYR:monitor-live -->
# /monitor-live - Launch Interactive Persistent Task Monitor

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Opens a persistent task monitor in a **visible Terminal.app window** where the CTO can watch the Claude Code TUI output in real-time and optionally type messages to intervene. All automated behavior (heartbeats, amendment detection, sub-agent spawning) continues working.

If a headless monitor is already running for the task, it is terminated first to prevent duplicates.

Accepts optional argument: `/monitor-live <task-id-prefix>` or bare `/monitor-live`.

---

## Step 1: Resolve Task

**If argument provided** (e.g., `/monitor-live 5439cfd4`):

Use the provided prefix as the `task_id` in Step 2.

**If no argument provided**:

Call `mcp__persistent-task__list_persistent_tasks({})` and display active tasks:

```
| # | ID Prefix | Title                       | Status | Cycles | Heartbeat |
|---|----------|-----------------------------|--------|--------|-----------|
| 1 | 5439cfd4 | AWS one-click demo E2E      | active | 204    | 2m ago    |
| 2 | a1b2c3d4 | Refactor auth middleware     | active | 50     | 1m ago    |
```

Ask the CTO to select one. Use the selected task's ID prefix.

---

## Step 2: Launch via MCP Tool

Call:

```
mcp__agent-tracker__launch_interactive_monitor({ task_id: "<task_id_or_prefix>" })
```

This single tool call handles everything:
- Resolves the task by prefix
- Validates it is `active`
- Kills any existing headless monitor (SIGTERM)
- Generates a unique agent ID
- Detects and configures proxy env vars
- Writes a launch script to `/tmp/`
- Opens a Terminal.app window via AppleScript

---

## Step 3: Report Result

If the tool returns `launched: true`, display:

```
Interactive monitor launched for "<taskTitle>"

  Task ID:  <taskId>
  Agent ID: <agentId>
  Killed:   <killedPid or "no existing monitor">
  Proxy:    <proxyEnabled>

The monitor will read its task details and begin the monitoring loop.
You can type messages in the Terminal window to intervene at any time.

If the session dies, the standard revival system will spawn a headless
replacement after ~5 minutes. Re-run /monitor-live to stay interactive.
```

If the tool returns an error, display the error message and suggest fixes:
- "not active" → suggest `mcp__persistent-task__resume_persistent_task`
- "requires macOS" → report this feature is macOS-only
- "Multiple tasks match" → ask CTO to provide a longer prefix

---

## Notes

- **macOS only** — uses Terminal.app via AppleScript.
- The `GENTYR_INTERACTIVE_MONITOR=true` env var bypasses the interactive-agent-guard and lockdown guard so the monitor can spawn sub-agents.
- Heartbeat, amendment detection, and cycle tracking work via `persistent-task-briefing.js` which checks `GENTYR_PERSISTENT_TASK_ID` (not `CLAUDE_SPAWNED_SESSION`).
