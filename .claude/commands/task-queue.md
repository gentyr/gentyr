<!-- HOOK:GENTYR:task-queue -->
# /task-queue - Rich Queue Visualization

$ARGUMENTS

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Displays a rich visualization of the current session queue with live activity
snippets for running sessions, plus drill-down capabilities.

Optional argument: number of items to show (default 15). Example: `/task-queue 30`

## Step 1: Parse Arguments

If `$ARGUMENTS` is a number, use it as the item count limit (default: 15).

## Step 2: Gather Queue Data

Call both tools in parallel:

```
mcp__show__show_session_queue()
mcp__agent-tracker__get_session_activity_summary()
```

The `show_session_queue` widget renders the standard queue overview.

The `get_session_activity_summary` returns live activity snippets for each
running session.

## Step 3: Display Activity Snippets

After the queue widget, display a **Running Session Activity** table using
data from `get_session_activity_summary`:

```
RUNNING SESSION ACTIVITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Agent            Type              Elapsed   Last Tool
─────────────────────────────────────────────────────────
<agent_id>       <agent_type>      <elapsed> [<last_tool>]
  └─ <worktree_path if set>
```

If `get_session_activity_summary` returns no sessions, omit this section.

## Step 4: Display Drill-Down Hints

After the activity table, always show:

```
DRILL-DOWN TOOLS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Inspect a session:   mcp__agent-tracker__peek_session({ agent_id: "...", depth: 16 })
• Suspend a session:   mcp__agent-tracker__suspend_session({ queue_id: "...", requeue_priority: "low" })
• Reprioritize queued: mcp__agent-tracker__reorder_queue({ queue_id: "...", new_priority: "urgent" })
• Cancel queued:       mcp__agent-tracker__cancel_queued_session({ queue_id: "..." })
• Drain queue now:     mcp__agent-tracker__drain_session_queue({})
```

Replace `"..."` with actual IDs from the queue data above.

## Notes

- `peek_session` accepts `agent_id` (from `get_session_activity_summary`) or
  `queue_id` (from `show_session_queue`). The `depth` param controls how many KB
  to scan from the end of the session file (default 8, max useful ~32).

- `suspend_session` sends SIGKILL to the process and requeues it at the specified
  priority. The session will resume from where it left off when the queue drains
  (if the session JSONL is discoverable).

- `reorder_queue` only works on items with status `queued` (not yet running).
