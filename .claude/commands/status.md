<!-- HOOK:GENTYR:show -->
# /status -- One-Shot System Status

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Runs the same data-gathering and display logic as `/monitor` but executes exactly **once** -- no sleep/repeat cycle, no state file, no reminder hook. Use this for a quick snapshot of the system.

Accepts optional argument: `/status plans`, `/status persistent`, `/status <plan-id-prefix>`, `/status <task-id-prefix>`, or bare `/status`.

---

## Step 1: Determine Scope

**If argument is `plans`** -> focus on plans
**If argument is `persistent`** -> focus on persistent tasks
**If argument looks like a plan ID** -> focus on that specific plan
**If argument is a task ID prefix** -> focus on that specific persistent task
**Otherwise** -> show everything (plans + persistent tasks + tasks + queue)

For plan selection, call `mcp__plan-orchestrator__list_plans({})` and show a selection table.
For persistent task selection, call `mcp__persistent-task__list_persistent_tasks({})` and show a selection table.

Do NOT call `update_monitor_state` or write any state files.

---

## Step 2: Gather Data

**YOU call MCP tools directly. Do NOT spawn investigator sub-agents.**

### Step 2a: PLANS

Call `mcp__plan-orchestrator__list_plans({ status: 'active' })`.

Display a compact plan table:

```
### Plans
| Plan | Progress | Phases | Tasks | Ready | Blocked |
|------|----------|--------|-------|-------|---------|
| [title 30ch] | 45% | 2/4 | 5/12 | 2 | No |
```

For each active plan, call `mcp__plan-orchestrator__plan_dashboard({ plan_id })` and display its formatted output.

For any plan showing paused tasks or low progress, call `mcp__plan-orchestrator__get_plan_blocking_status({ plan_id })` and note blocked/available work.

For plan managers, call `mcp__plan-orchestrator__get_spawn_ready_tasks({ plan_id })` and list which tasks are ready to spawn next.

### Step 2b: PERSISTENT TASKS

For each active persistent task (or the selected one):
```
mcp__agent-tracker__inspect_persistent_task({ id: "<task_id>" })
```

Display a compact status table:

```
### Persistent Tasks
| Task | Status | Cycles | Heartbeat | Monitor | Children | Plan |
|------|--------|--------|-----------|---------|----------|------|
| [title 30ch] | active | 126 | 2m ago | alive | 3 running | [plan title] 3/7 |
```

The **Plan** column shows plan context when `planContext` is present:
- For plan-managed tasks: `[plan title] N/M`
- For plan managers (`isPlanManager: true`): `MANAGER: [plan title] N/M`
- For non-plan tasks: leave blank

Note the monitor's `lastSummary` field (1-2 sentences, if available).

### Step 2c: TASKS

Call `mcp__todo-db__list_tasks({ status: 'in_progress', limit: 20 })`.

Display a compact task table:

```
### Active Tasks
| ID | Title | Category | Priority | Assigned By | Age |
|----|-------|----------|----------|-------------|-----|
| abc123 | Fix auth timeout | Standard Dev | normal | deputy-cto | 15m |
```

If there are pending tasks with urgent priority, also show:
```
mcp__todo-db__list_tasks({ status: 'pending', priority: 'urgent', limit: 10 })
```

### Step 2d: BROWSE SESSIONS

For each active session (monitor + running children), call:

```
mcp__agent-tracker__browse_session({ agent_id: "<agent_id>", page_size: 15 })
```

Display verbatim indexed messages (same format as `/monitor`):

```
### agent-mnvwjhrj -- Monitor: AWS Login Chain
Messages 270-284 of 284

  #270 [16:22:30] [text] Let me check the bridge connection status...
  #271 [16:22:31] [tool] mcp__chrome-bridge__tabs_context_mcp
  ...
```

**Offset adjustment:** If latest messages are just sleep/polling, page backward to find the diagnostic window.

### Step 2e: QUEUE

```
mcp__agent-tracker__get_session_queue_status({})
```

Show one line: `Queue: N/M running | memory: low | N queued | N suspended`

### Step 2f: ASSESS

Write **3-5 sentences** with specific evidence from Steps 2a-2e. Reference message indices and plan progress:
- "Plan 'Release v2.1' at 67% -- Phase 3 blocked, 2 parallel tasks available"
- "Monitor acquired display lock at #274 and launched demo at #276"
- "3 in_progress todo-db tasks, no stale items"

**End with a verdict:** `Healthy`, `Warning -- <reason>`, or `INTERVENTION NEEDED -- <reason>`

---

## Step 3: Done

Output is complete. Do NOT loop, sleep, or repeat. Do NOT call `update_monitor_state` or `stop_monitoring`.

---

## Rules

**DO:**
- Call MCP tools directly -- no investigator sub-agents
- Show `browse_session` output as indexed messages with timestamps
- Reference message indices in your assessment
- Page backward through history when recent messages are uninteresting
- Show plan dashboard output for each active plan
- Check plan blocking status when plans have paused tasks

**DO NOT:**
- Loop, sleep, or repeat -- this is a one-shot command
- Call `update_monitor_state` or `stop_monitoring` -- no state management
- Use Bash to write or delete state files
- Spawn investigator or user-alignment sub-agents
- Paraphrase or summarize session messages -- show them verbatim
- Skip the browse step -- it's the most valuable part
- Write vague assessments -- cite specific message indices, plan progress, and tool calls
