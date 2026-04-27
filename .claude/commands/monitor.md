<!-- HOOK:GENTYR:monitor -->
# /monitor -- Live System Monitor

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Enters a continuous monitoring loop that shows the CTO **raw data** from plans, persistent tasks, todo-db tasks, running sessions, and the session queue. Each round calls MCP tools directly and displays verbatim indexed session messages -- no LLM summaries, no investigator sub-agents.

Accepts optional argument: `/monitor plans`, `/monitor persistent`, `/monitor <plan-id-prefix>`, `/monitor <task-id-prefix>`, or bare `/monitor`.

---

## Step 1: Determine Scope

**If argument is `plans`** -> list active plans, let CTO select
**If argument is `persistent`** -> list persistent tasks, let CTO select
**If argument looks like a plan ID** (starts with plan prefix or matches UUID) -> monitor that specific plan
**If argument is a task ID prefix** -> monitor that specific persistent task
**Otherwise** -> default to monitoring everything (plans + persistent tasks + tasks + queue)

For plan selection, call `mcp__plan-orchestrator__list_plans({})` and show a selection table.
For persistent task selection, call `mcp__persistent-task__list_persistent_tasks({})` and show a selection table.

---

## Step 2: Initialize

Create the monitoring state via MCP (NOT Bash -- never write state files with Bash):

```
mcp__agent-tracker__update_monitor_state({
  round_number: 0,
  monitored_sessions: [],
  monitored_task_ids: ["<selected persistent task IDs>"],
  monitored_plan_ids: ["<selected plan IDs>"],
  current_step: "INIT"
})
```

This writes `.claude/state/monitor-active.json` which the `monitor-reminder.js` PostToolUse hook reads to inject reminders every 10 tool calls.

Record loop state:
- `roundNumber = 0`
- `previousCycleCounts = {}` -- task ID -> last cycle count

---

## Step 3: Monitoring Loop

**YOU call MCP tools directly. Do NOT spawn investigator sub-agents.**

Each round:

### Step 3a: PLANS

Call `mcp__plan-orchestrator__list_plans({ status: 'active' })`.

Display a compact plan table:

```
## Round N (HH:MM)

### Plans
| Plan | Progress | Phases | Tasks | Ready | Blocked |
|------|----------|--------|-------|-------|---------|
| [title 30ch] | 45% | 2/4 | 5/12 | 2 | No |
```

For each active plan, call `mcp__plan-orchestrator__plan_dashboard({ plan_id })` and display its formatted output.

For any plan showing paused tasks or low progress, call `mcp__plan-orchestrator__get_plan_blocking_status({ plan_id })` and note blocked/available work.

For plan managers, call `mcp__plan-orchestrator__get_spawn_ready_tasks({ plan_id })` and list which tasks are ready to spawn next.

### Step 3b: PERSISTENT TASKS

For each monitored persistent task (or all active if monitoring everything):
```
mcp__agent-tracker__inspect_persistent_task({ id: "<task_id>" })
```

Display a compact status table:

```
### Persistent Tasks
| Task | Status | Cycles | Delta | Heartbeat | Monitor | Children | Plan |
|------|--------|--------|-------|-----------|---------|----------|------|
| [title 30ch] | active | 126 | +4 | 2m ago | alive | 3 running | [plan title] 3/7 |
```

The **Plan** column shows plan context when `planContext` is present in the `inspect_persistent_task` response:
- For plan-managed tasks: `[plan title] N/M` (completed/total plan tasks)
- For plan managers (`isPlanManager: true`): `MANAGER: [plan title] N/M`
- For non-plan tasks: leave blank

Note the monitor's `lastSummary` field (1-2 sentences, if available).

### Step 3c: TASKS

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

### Step 3d: BROWSE SESSIONS

**This is the core of the design.** For each active session (monitor + running children), call:

```
mcp__agent-tracker__browse_session({ agent_id: "<agent_id>", page_size: 15 })
```

**Display the output verbatim as indexed messages:**

```
### agent-mnvwjhrj -- Monitor: AWS Login Chain
Messages 270-284 of 284

  #270 [16:22:30] [text] Let me check the bridge connection status before acquiring locks...
  #271 [16:22:31] [tool] mcp__chrome-bridge__tabs_context_mcp
  #272 [16:22:32] [result] { tabs: [], groups: [] }
  #273 [16:22:33] [text] Bridge connected, no tabs open. Clean state. Locks expire at 16:24...
  #274 [16:24:53] [tool] mcp__agent-tracker__acquire_shared_resource (resource_id: "display")
  #275 [16:24:54] [result] { acquired: true }
  #276 [16:25:01] [tool] mcp__playwright__run_demo (scenario_id: "c6fda62f...", headless: false)
  ...

  [284 total -- browse earlier: browse_session({ before_index: 270 })]
```

**Formatting rules for each message type:**
- `assistant_text` -> `#N [HH:MM:SS] [text] <content>`
- `tool_call` -> `#N [HH:MM:SS] [tool] <tool_name> (<input_preview>)`
- `tool_result` -> `#N [HH:MM:SS] [result] <preview>`
- `user` -> `#N [HH:MM:SS] [user] <content>`
- `compaction` -> `#N [HH:MM:SS] [compacted] <reason>`
- `error` -> `#N [HH:MM:SS] [ERROR] <message>`

**Offset adjustment:** After retrieving messages, preview them to check if they're diagnostic. If the latest messages are just sleep/polling with no substance:
1. Page backward: `browse_session({ agent_id, page_size: 15, before_index: <range.start_index> })`
2. Find the window where the agent last made a real decision or encountered an error
3. Show THAT window to the CTO

**Multiple sessions:** Show the monitor session first, then each running child session, separated by headers.

### Step 3e: QUEUE

```
mcp__agent-tracker__get_session_queue_status({})
```

Show one line: `Queue: N/M running | memory: low | N queued | N suspended`

### Step 3f: ASSESS

Write **3-5 sentences** with specific evidence from Steps 3a-3e. Reference message indices and plan progress:
- "Plan 'Release v2.1' at 67% -- Phase 3 blocked, 2 parallel tasks available in Phase 2"
- "Monitor acquired display lock at #274 and launched demo at #276"
- "Child agent-xyz has been polling check_demo_result since #180 (3 min ago)"
- "3 in_progress todo-db tasks, no stale items"

**End with a verdict:** `Healthy`, `Warning -- <reason>`, or `INTERVENTION NEEDED -- <reason>`

### Step 3g: UPDATE STATE AND SLEEP

Update monitoring state via MCP:

```
mcp__agent-tracker__update_monitor_state({
  round_number: N,
  monitored_sessions: ["<current agent IDs from inspect>"],
  monitored_task_ids: ["<task IDs>"],
  monitored_plan_ids: ["<plan IDs>"],
  current_step: "SLEEP"
})
```

Then sleep:

```
---
Sleeping 60s before Round N+1... (Ctrl+C to stop)
```

`Bash("sleep 60")`

Return to Step 3a. Increment `roundNumber`.

---

## Step 4: Intervention Conditions

Stop the loop and alert if:
1. Monitor PID dead with no revival queued
2. Persistent task transitioned to `paused` or `completed`
3. Critical memory pressure for 3+ consecutive rounds
4. Child agent stale for 15+ minutes (no tool calls)
5. Plan fully blocked with no parallel work available for 3+ rounds
6. All plan tasks completed but plan still marked active (stale completion)
7. Systemic error pattern across 3+ child attempts

Display recommended action for each condition.

---

## Step 5: Cleanup

When monitoring ends (user interrupt, intervention, or all tasks done):

```
mcp__agent-tracker__stop_monitoring({})
```

---

## Rules

**DO:**
- Call MCP tools directly -- no investigator sub-agents
- Use `update_monitor_state` to track round progress (NEVER write state files with Bash)
- Use `stop_monitoring` to clean up (NEVER use `Bash("rm ...")` for state files)
- Show `browse_session` output as indexed messages with timestamps
- Reference message indices in your assessment ("at #274...")
- Page backward through history when recent messages are uninteresting
- Continue looping until all sessions are done or CTO interrupts
- Show plan dashboard output for each active plan
- Check plan blocking status when plans have paused tasks

**DO NOT:**
- Use Bash to write or delete state files -- always use MCP tools
- Spawn investigator or user-alignment sub-agents
- Paraphrase or summarize session messages -- show them verbatim
- Skip the browse step -- it's the most valuable part
- Write vague assessments -- cite specific message indices, plan progress, and tool calls
- Call `sleep` for more than 60s between rounds
