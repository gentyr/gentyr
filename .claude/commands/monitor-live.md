<!-- HOOK:GENTYR:monitor-live -->
# /monitor-live - Join Any Running Session Interactively

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Opens ANY agent session in a **visible Terminal.app window** with full conversation history. The CTO can watch the session's work in real-time and type messages to intervene. Supports persistent task monitors, child agents, todo task runners, and any session in the queue.

Kills the headless process before resuming so there's no conflict — the session picks up exactly where it left off.

Accepts optional argument: `/monitor-live <identifier>` or bare `/monitor-live`.

---

## Step 1: Resolve Target Session

**If argument provided** — determine the identifier type:

- **Persistent task ID prefix** (e.g., `b33e3760`): Use `task_id` parameter
- **Session UUID** (36-char UUID): Use `session_id` parameter
- **Queue item ID** (e.g., `sq-mng5s6np-...`): Use `queue_id` parameter
- **Agent ID** (e.g., `agent-b62fe048-16901`): Use `agent_id` parameter

Skip to Step 3 with the identified parameter.

**If no argument provided** — show running sessions:

First, show the visual session queue table:

```
mcp__show__show_session_queue({})
```

This renders a rich table of all running, queued, and suspended sessions with PIDs, elapsed time, and agent types.

Then call:

```
mcp__agent-tracker__get_session_queue_status({})
```

From the response, build a selection table showing `runningItems`:

```
| # | Queue ID     | Title                              | Agent Type | PID   | Elapsed | Agent ID         |
|---|--------------|-------------------------------------|-----------|-------|---------|------------------|
| 1 | sq-mng5s6np  | [Persistent] Monitor: AWS demo E2E  | pt-monitor| 42027 | 2h 15m  | agent-b62fe048   |
| 2 | sq-mngatvq9  | [Task] Fix stale tab ID             | code-rvw  | 48419 | 28m     | agent-mng6gbp4   |
| 3 | sq-mng720y1  | [Task] Run demo validation          | demo-mgr  | 53637 | 12m     | agent-mng720ze   |
```

Ask the CTO to select which session to join. Use their selection to determine the `queue_id`.

---

## Step 2: Check for Persistent Tasks (if no argument)

Also check for active persistent tasks:

```
mcp__persistent-task__list_persistent_tasks({})
```

If there are active persistent tasks, show them alongside the queue:

```
| # | Task ID Prefix | Title                    | Status | Cycles | Monitor    |
|---|---------------|--------------------------|--------|--------|------------|
| A | b33e3760      | AWS demo E2E             | active | 204    | PID 42027  |
| B | a1b2c3d4      | Refactor auth middleware  | active | 50     | PID 91829  |
```

The CTO can select from either table. Persistent tasks use `task_id`, queue items use `queue_id`.

---

## Step 3: Launch via MCP Tool

Call with the appropriate parameter:

```
mcp__agent-tracker__launch_interactive_monitor({ task_id: "<prefix>" })
mcp__agent-tracker__launch_interactive_monitor({ session_id: "<uuid>" })
mcp__agent-tracker__launch_interactive_monitor({ queue_id: "<sq-id>" })
mcp__agent-tracker__launch_interactive_monitor({ agent_id: "<agent-id>" })
```

**Cross-project sessions**: If the target session belongs to a different project (e.g., monitoring `~/git/my-project` agents from the gentyr repo), add the `project_dir` parameter:

```
mcp__agent-tracker__launch_interactive_monitor({ task_id: "<prefix>", project_dir: "/Users/you/git/my-project" })
```

The tool reads that project's DBs (session-queue.db, persistent-tasks.db) and searches that project's worktree session directories. The generated Terminal.app script `cd`s to the target project and sets `CLAUDE_PROJECT_DIR` accordingly.

This single tool call handles everything:
- Resolves the session from the provided identifier
- Kills the headless process (SIGTERM)
- Finds the session JSONL file (including worktree-scoped session dirs)
- Uses `claude --resume <session-id>` to continue with full history
- Detects and configures proxy env vars
- Opens a Terminal.app window via AppleScript

---

## Step 4: Report Result

If `resumed: true`:
```
Resumed session in Terminal.app — "<title>"

  Session:   <sessionId>
  Agent:     <agentId>
  Killed:    PID <killedPid> (was running headless)

Full conversation history is visible. Type in the window to intervene.
```

If `resumed: false`:
```
Fresh session launched in Terminal.app — "<title>"

  Agent: <agentId>

No prior session found to resume. Starting fresh.
```

If error, display the error and suggest alternatives based on the error type.

---

## Quick Join (without slash command)

The CTO can also ask naturally: "join that session", "let me watch the monitor", "open the code-writer session in a terminal". The AI should:

1. Identify which session from context (recent tool calls, `/monitor-tasks` output, etc.)
2. Call `mcp__agent-tracker__launch_interactive_monitor` directly with the appropriate ID
3. Report the result

No slash command needed — the MCP tool works standalone.

---

## Notes

- **macOS only** — uses Terminal.app via AppleScript.
- The `GENTYR_INTERACTIVE_MONITOR=true` env var bypasses the interactive-agent-guard and lockdown guard.
- When resuming, the full conversation history is loaded by `claude --resume`.
- Heartbeat and amendment detection continue via `persistent-task-briefing.js` (checks `GENTYR_PERSISTENT_TASK_ID`).
- If the interactive session dies, the revival system spawns a headless replacement after ~5 minutes. Re-run `/monitor-live` to stay interactive.
