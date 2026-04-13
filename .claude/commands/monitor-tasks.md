<!-- HOOK:GENTYR:monitor-tasks -->
# /monitor-tasks — Live Session Monitor

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Enters a continuous monitoring loop that shows the CTO **raw session data** from running agents and persistent task monitors. Each round calls MCP tools directly and displays verbatim indexed session messages — no LLM summaries, no investigator sub-agents.

Accepts optional argument: `/monitor-tasks persistent`, `/monitor-tasks <task-id-prefix>`, or bare `/monitor-tasks`.

---

## Step 1: Determine Scope

**If argument is `persistent`** → list persistent tasks, let CTO select
**If argument is a task ID prefix** → monitor that specific task
**Otherwise** → ask:

```
AskUserQuestion: What to monitor?
  - "All active persistent tasks"
  - "All running sessions"
```

For persistent tasks, call `mcp__persistent-task__list_persistent_tasks({})` and show a selection table.

---

## Step 2: Initialize

Create the monitoring state via MCP (NOT Bash — never write state files with Bash):

```
mcp__agent-tracker__update_monitor_state({
  round_number: 0,
  monitored_sessions: [],
  monitored_task_ids: ["<selected task IDs>"],
  current_step: "INIT"
})
```

This writes `.claude/state/monitor-tasks-active.json` which the `monitor-tasks-reminder.js` PostToolUse hook reads to inject reminders every 10 tool calls.

Record loop state:
- `roundNumber = 0`
- `previousCycleCounts = {}` — task ID → last cycle count

---

## Step 3: Monitoring Loop

**YOU call MCP tools directly. Do NOT spawn investigator sub-agents.**

Each round:

### Step 3a: OVERVIEW

For each monitored persistent task:
```
mcp__agent-tracker__inspect_persistent_task({ id: "<task_id>" })
```

Display a compact status table:

```
## Round N (HH:MM)

| Task | Status | Cycles | Δ | Heartbeat | Monitor | Children |
|------|--------|--------|---|-----------|---------|----------|
| [title 30ch] | active | 126 | +4 | 2m ago | alive | 3 running |
```

Note the monitor's `lastSummary` field (1-2 sentences, if available).

### Step 3b: BROWSE SESSIONS

**This is the core of the design.** For each active session (monitor + running children), call:

```
mcp__agent-tracker__browse_session({ agent_id: "<agent_id>", page_size: 15 })
```

**Display the output verbatim as indexed messages:**

```
### agent-mnvwjhrj — Monitor: AWS Login Chain
Messages 270-284 of 284

  #270 [16:22:30] [text] Let me check the bridge connection status before acquiring locks...
  #271 [16:22:31] [tool] mcp__chrome-bridge__tabs_context_mcp
  #272 [16:22:32] [result] { tabs: [], groups: [] }
  #273 [16:22:33] [text] Bridge connected, no tabs open. Clean state. Locks expire at 16:24...
  #274 [16:24:53] [tool] mcp__agent-tracker__acquire_shared_resource (resource_id: "display")
  #275 [16:24:54] [result] { acquired: true }
  #276 [16:25:01] [tool] mcp__playwright__run_demo (scenario_id: "c6fda62f...", headless: false)
  ...

  [284 total — browse earlier: browse_session({ before_index: 270 })]
```

**Formatting rules for each message type:**
- `assistant_text` → `#N [HH:MM:SS] [text] <content>`
- `tool_call` → `#N [HH:MM:SS] [tool] <tool_name> (<input_preview>)`
- `tool_result` → `#N [HH:MM:SS] [result] <preview>`
- `user` → `#N [HH:MM:SS] [user] <content>`
- `compaction` → `#N [HH:MM:SS] [compacted] <reason>`
- `error` → `#N [HH:MM:SS] [ERROR] <message>`

**Offset adjustment:** After retrieving messages, preview them to check if they're diagnostic. If the latest messages are just sleep/polling with no substance:
1. Page backward: `browse_session({ agent_id, page_size: 15, before_index: <range.start_index> })`
2. Find the window where the agent last made a real decision or encountered an error
3. Show THAT window to the CTO

**Multiple sessions:** Show the monitor session first, then each running child session, separated by headers.

### Step 3c: QUEUE

```
mcp__agent-tracker__get_session_queue_status({})
```

Show one line: `Queue: N/M running | memory: low | N queued`

### Step 3d: ASSESS

Write **3-5 sentences** with specific evidence from Steps 3a-3b. Reference message indices:
- "Monitor acquired display lock at #274 and launched demo at #276"
- "Child agent-xyz has been polling check_demo_result since #180 (3 min ago)"
- "No errors in recent 15 messages; last substantive action was at #265"

**End with a verdict:** `Healthy`, `Warning — <reason>`, or `INTERVENTION NEEDED — <reason>`

### Step 3e: UPDATE STATE AND SLEEP

Update monitoring state via MCP:

```
mcp__agent-tracker__update_monitor_state({
  round_number: N,
  monitored_sessions: ["<current agent IDs from inspect>"],
  monitored_task_ids: ["<task IDs>"],
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
2. Task transitioned to `paused` or `completed`
3. Critical memory pressure for 3+ consecutive rounds
4. Child agent stale for 15+ minutes (no tool calls)

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
- Call MCP tools directly — no investigator sub-agents
- Use `update_monitor_state` to track round progress (NEVER write state files with Bash)
- Use `stop_monitoring` to clean up (NEVER use `Bash("rm ...")` for state files)
- Show `browse_session` output as indexed messages with timestamps
- Reference message indices in your assessment ("at #274...")
- Page backward through history when recent messages are uninteresting
- Continue looping until all sessions are done or CTO interrupts

**DO NOT:**
- Use Bash to write or delete state files — always use MCP tools
- Spawn investigator or user-alignment sub-agents
- Paraphrase or summarize session messages — show them verbatim
- Skip the browse step — it's the most valuable part
- Write vague assessments — cite specific message indices and tool calls
- Call `sleep` for more than 60s between rounds
