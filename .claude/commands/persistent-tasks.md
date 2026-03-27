<!-- HOOK:GENTYR:persistent-tasks -->
# /persistent-tasks - List and Manage Persistent Tasks

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Lists all persistent tasks and provides management actions: view details, amend, pause, resume, cancel, and revive dead monitor sessions.

## Step 1: List All Persistent Tasks

Call:

```
mcp__persistent-task__list_persistent_tasks({})
```

Display a table of all tasks:

```
| # | Title                       | Status    | Progress    | Monitor   | Amendments | Bridge | Age  |
|---|-----------------------------|-----------|-------------|-----------|------------|--------|------|
| 1 | Migrate auth to OAuth2      | active    | 3/7 (43%)   | running   | 2          | MCP    | 4h   |
| 2 | Refactor database layer     | active    | 1/4 (25%)   | DEAD      | 0          |        | 2d   |
| 3 | Add payment integration     | draft     | 0/0 (0%)    | pending   | 1          | MCP    | 10m  |
| 4 | Improve API test coverage   | completed | 8/8 (100%)  | finished  | 0          |        | 1d   |
```

**Status color indicators:**
- Green: task is active, monitor is running, progress within the last hour
- Yellow: task is active but stalled (no progress in 1h+), OR there are unacknowledged amendments
- Red: monitor is dead, or task is in `failed` status
- Grey: task is `completed`, `cancelled`, or `paused`

If no tasks exist, display: "No persistent tasks found. Use /persistent-task to create one."

## Step 2: Choose Action

Use `AskUserQuestion` with `multiSelect: false` and these options:

- **Inspect** — Deep-dive into a task: monitor decisions, child activity, blockers (calls inspect_persistent_task)
- **View details** — See the full task info, sub-tasks, and amendment history
- **Amend a task** — Add an amendment to a running persistent task
- **Pause a task** — Pause a running persistent task
- **Resume a task** — Resume a paused persistent task
- **Cancel a task** — Cancel and stop monitoring
- **Revive monitor** — Re-spawn a dead monitor session for an active task
- **Done** — Exit

## Step 3: Execute the Action

### Inspect

1. Ask the CTO which task number to inspect (any status, but most useful for `active`)
2. Call:
   ```
   mcp__agent-tracker__inspect_persistent_task({ id: "<id>" })
   ```
3. Display the results in this structured format:

   **Task State**
   ```
   Title: <title>
   Status: <status> | Cycles: <cycleCount> | Last heartbeat: <relative time>
   Outcome criteria: <outcomeCriteria>
   ```

   **Monitor** (if present)
   ```
   Agent: <agentId> | PID: <pid> (<alive/dead>) | Stage: <progress.currentStage> (<progress.progressPercent>%)
   ```
   Then show the monitor's last 5 assistant_text and tool_call activity entries as a timeline:
   ```
   [14:30:02] 🤖 "Checking sub-task progress for test-writer..."
   [14:30:05] 🔧 mcp__todo-db__list_tasks({ section: "TEST-WRITER", status: "in_progress" })
   [14:30:06] 📋 Result: Found 2 tasks in progress...
   [14:30:08] 🤖 "Both test-writer tasks are progressing well. Creating next batch..."
   [14:30:10] 🔧 mcp__todo-db__create_task({ title: "Write API integration tests", ... })
   ```

   **Amendments** (if any)
   ```
   1. [addendum, 2h ago] "Also add retry logic" — ✅ acknowledged
   2. [scope_change, 10m ago] "Skip the auth tests for now" — ⏳ pending
   ```

   **Children** (<running>/<total> running)
   For each running child, show:
   ```
   [in_progress] "Write payment tests" — TEST-WRITER
     Agent: abc123 | PID: 12345 (alive) | Stage: code-writer (60%)
     Last: 🔧 Edit({ file_path: "tests/payment.test.ts", ... })
     Git: feature/payment-tests — 2 commits
   ```
   For non-running children, show a compact one-liner:
   ```
   [completed] "Implement auth flow" — CODE-REVIEWER ✅
   [pending] "API endpoint refactor" — CODE-REVIEWER ⏳
   ```

   **Recent Events** (last 5)
   ```
   [14:25] heartbeat
   [14:20] sub_task_completed — "Auth flow tests passing"
   [14:15] amendment_acknowledged — correction #2
   ```

4. Return to Step 2.

### View details

1. Ask the CTO which task number to view
2. Fetch full details:
   ```
   mcp__persistent-task__get_persistent_task({ id: "<id>", include_amendments: true, include_subtasks: true })
   ```
3. Display:

   **Task Info**: title, status, created at, activated at, cycle count, last heartbeat, monitor PID

   **Original Prompt**: full prompt text

   **Amendments** (in chronological order):
   ```
   1. [addendum, 2026-03-24 14:30, cto] "Also make sure auth works with SSO"
      Acknowledged: yes (2026-03-24 14:32)
   2. [scope_change, 2026-03-24 15:00, cto] "Focus on the API layer first"
      Acknowledged: no — PENDING
   ```

   **Sub-Tasks**:
   ```
   [completed] "Implement auth flow" — CODE-REVIEWER
   [in_progress] "Write auth tests" — TEST-WRITER — agent running
   [pending] "API endpoint refactor" — CODE-REVIEWER
   ```

   **Outcome Criteria**: the success criteria defined at creation

4. Return to Step 2.

### Amend a task

1. Ask the CTO which task number to amend (must be `draft`, `active`, or `paused`)
2. Ask for the amendment text (free text)
3. Ask for the amendment type using `AskUserQuestion` with `multiSelect: false`:
   - **addendum** — Additional requirement to incorporate
   - **correction** — Error in the current approach that needs fixing
   - **scope_change** — Revised scope boundaries
   - **priority_shift** — Change in priority ordering of work
4. Call:
   ```
   mcp__persistent-task__amend_persistent_task({
     id: "<id>",
     content: "<amendment text>",
     amendment_type: "<type>"
   })
   ```
5. Display confirmation:
   ```
   Amendment added and signaled to the monitor session.
   The monitor will acknowledge it within its next signal-check cycle (every 5 tool calls).
   ```
6. Return to Step 2.

### Pause a task

1. Ask the CTO which task number to pause (must be `active`)
2. Optionally ask for a reason (free text, or skip with Enter)
3. Call:
   ```
   mcp__persistent-task__pause_persistent_task({ id: "<id>", reason: "<reason or empty string>" })
   ```
4. Display confirmation:
   ```
   Task "<title>" paused. The monitor session will wrap up its current cycle and stop.
   Use /persistent-tasks -> Resume to restart it.
   ```
5. Return to Step 2.

### Resume a task

1. Ask the CTO which task number to resume (must be `paused`)
2. Call:
   ```
   mcp__persistent-task__resume_persistent_task({ id: "<id>" })
   ```
3. Display confirmation:
   ```
   Task "<title>" resumed. A new monitor session has been spawned.
   ```
4. Return to Step 2.

### Cancel a task

1. Ask the CTO which task number to cancel (must be `active`, `paused`, or `draft`)
2. Use `AskUserQuestion` to confirm:
   > Cancelling "<title>" will stop the monitor session and mark all in-progress sub-tasks as cancelled. This cannot be undone. Proceed?
   - **Yes, cancel it**
   - **No, go back**
3. If confirmed, call:
   ```
   mcp__persistent-task__cancel_persistent_task({ id: "<id>" })
   ```
4. Display confirmation:
   ```
   Task "<title>" cancelled. The monitor session has been signaled to stop.
   ```
5. Return to Step 2.

### Revive monitor

1. Ask the CTO which task number to revive (must be `active` with a dead monitor)
2. Call:
   ```
   mcp__persistent-task__resume_persistent_task({ id: "<id>" })
   ```
   This re-activates the task and spawns a fresh monitor session. The new monitor will read the full task state (including all amendments and sub-task progress) on startup.
3. Display confirmation:
   ```
   Monitor session re-spawned for "<title>".
   The new monitor will resume from the current sub-task progress.
   ```
4. Return to Step 2.

### Done

Display a brief summary and exit:

```
Session complete.
Active tasks: N  |  Completed: N  |  Dead monitors: N
```

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `mcp__persistent-task__list_persistent_tasks` | List all tasks with status |
| `mcp__persistent-task__get_persistent_task` | Full details including amendments and sub-tasks |
| `mcp__persistent-task__amend_persistent_task` | Add an amendment, signal the monitor |
| `mcp__persistent-task__pause_persistent_task` | Pause a running task |
| `mcp__persistent-task__resume_persistent_task` | Resume a paused task or revive a dead monitor |
| `mcp__persistent-task__cancel_persistent_task` | Cancel and stop monitoring |
| `mcp__agent-tracker__inspect_persistent_task` | Deep inspection: monitor JSONL, child activity, amendments, git state |
