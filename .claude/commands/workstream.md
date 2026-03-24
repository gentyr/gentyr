<!-- HOOK:GENTYR:workstream -->
# /workstream - Manage Workstream Dependencies and Queue Coordination

Interactive command for managing queue-level task dependencies and workstream coordination. Provides a dependency graph view, change history, and allows the CTO to direct the workstream-manager agent to add, remove, or review dependencies.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Step 1: Display Current Workstream State

Call these tools in parallel:

```
mcp__workstream__get_queue_context({})
mcp__workstream__get_change_log({ limit: 10 })
mcp__workstream__list_dependencies({ status: "active" })
```

Display a dashboard:

### Queue State

Show running and queued items with their dependency status:

```
RUNNING (N):
  [sq-xxx] "Task title" — agent-type — CLEAR
  [sq-yyy] "Task title" — agent-type — BLOCKED (by task-abc)

QUEUED (N):
  [sq-zzz] "Task title" — agent-type — BLOCKED (by task-def)
  [sq-www] "Task title" — agent-type — CLEAR
```

### Active Dependencies

```
ACTIVE DEPENDENCIES (N):
  [dep-xxx] "<blocked_task>" BLOCKED BY "<blocker_task>"
            Reason: "..."
            Created: X min ago
```

If no active dependencies:
```
ACTIVE DEPENDENCIES: None — all tasks are running/queued independently
```

### Recent Changes (last 10)

```
RECENT WORKSTREAM CHANGES:
  1. [DEP ADDED] "task A" blocked by "task B" — 5m ago
  2. [ASSESSMENT] "task C" cleared — 12m ago
  3. [DEP SATISFIED] "task D" unblocked — 18m ago
```

## Step 2: Ask User What to Do

Use AskUserQuestion with **one question** (multiSelect: false):

- **"Add a dependency"** — Block a queued task until another completes
- **"Remove a dependency"** — Remove an existing dependency
- **"Run workstream assessment"** — Spawn workstream-manager to analyze the current queue
- **"View full change log"** — Show extended change history
- **"Reorder queue item priority"** — Change the priority of a queued item
- **"Done"** — Exit

## Step 3: Execute the Action

### If "Add a dependency":

Ask the CTO two follow-up questions:
1. **Blocked task**: which task should wait? (show active tasks with their IDs)
2. **Blocker task**: which task must complete first?
3. **Reasoning**: brief explanation (free text)

Then call:
```
mcp__workstream__add_dependency({
  blocked_task_id: "<id>",
  blocker_task_id: "<id>",
  reasoning: "..."
})
```

Display the result and go back to Step 2.

### If "Remove a dependency":

Show the list of active dependencies with their IDs. Ask the CTO to pick one.

Ask for removal reasoning (free text).

Call:
```
mcp__workstream__remove_dependency({
  dependency_id: "<dep-id>",
  reasoning: "..."
})
```

Display the result and go back to Step 2.

### If "Run workstream assessment":

Explain: "This will spawn a workstream-manager agent to analyze the current queue for conflicts and add necessary dependencies."

No additional input needed — spawn a `workstream-manager` sub-agent:

```javascript
Task({
  subagent_type: "workstream-manager",
  description: "Assess current queue state for workstream dependencies",
  prompt: `[CTO-directed assessment] Review the current session queue via mcp__workstream__get_queue_context({}) and identify any tasks that should have dependencies. For each conflict found, call mcp__workstream__add_dependency(). For tasks that are clearly independent, call mcp__workstream__record_assessment(). Be conservative — only add dependencies for real conflicts.`
})
```

After spawning, display:
```
Workstream-manager agent spawned. It will analyze the queue and add dependencies as needed.
Check results with: mcp__workstream__get_change_log({ limit: 10 })
```

Go back to Step 2.

### If "View full change log":

Ask how many records to show (default 50, options: 20 / 50 / 100 / all).

Call:
```
mcp__workstream__get_change_log({ limit: N })
```

Display the full history in reverse chronological order with task titles and timing.

Go back to Step 2.

### If "Reorder queue item priority":

Show queued items with their current priorities. Ask the CTO:
1. Which queue item to reorder (pick from list)
2. New priority: critical / urgent / normal / low
3. Reasoning (free text)

Call:
```
mcp__workstream__reorder_item({
  queue_id: "<sq-id>",
  new_priority: "<priority>",
  reasoning: "..."
})
```

Display the result and go back to Step 2.

### If "Done":

Exit. Display a brief summary:
```
Workstream session complete.
Active dependencies: N
Recent changes: N
```

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `mcp__workstream__get_queue_context` | Full queue state with dependency statuses |
| `mcp__workstream__list_dependencies` | List dependencies (filter by task_id or status) |
| `mcp__workstream__add_dependency` | Block one task until another completes |
| `mcp__workstream__remove_dependency` | Remove an existing dependency |
| `mcp__workstream__get_change_log` | Audit trail of all workstream changes |
| `mcp__workstream__reorder_item` | Change priority of a queued session |
| `mcp__workstream__record_assessment` | Record that a task was assessed (clear) |

## Notes

- Dependencies are tracked by **task ID** (from todo.db), not queue ID
- When a blocker task completes, the `workstream-dep-satisfier.js` hook automatically satisfies the dependency and triggers a queue drain
- The `workstream-notifier.js` hook injects workstream changes into every CTO prompt, so you are always notified of dependency events
- Dependencies should reflect real technical conflicts — avoid speculative blockers that slow down the queue without clear need
