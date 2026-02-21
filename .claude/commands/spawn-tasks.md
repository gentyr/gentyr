<!-- HOOK:GENTYR:spawn-tasks -->
# /spawn-tasks - Force-Spawn Pending TODO Tasks

On-demand command to **force-spawn all pending tasks immediately**, bypassing the hourly automation's age filter, batch limit, cooldowns, and CTO activity gate.

The prefetch hook has pre-gathered pending task counts, running agent info, and concurrency limits, injected as `[PREFETCH:spawn-tasks]` context above. Use that data for Step 1.

## Step 1: Display Current State

From the prefetch data, display a summary table:

| Section | Pending Tasks |
|---------|--------------|
| CODE-REVIEWER | N |
| INVESTIGATOR & PLANNER | N |
| TEST-WRITER | N |
| PROJECT-MANAGER | N |
| DEPUTY-CTO | N |
| **Total** | **N** |

Also show: **Running agents**: N / M (N running, M max concurrent, K available slots)

If there are **0 pending tasks**, inform the user and stop — nothing to spawn.

## Step 2: Ask User

Use AskUserQuestion with **two questions**:

**Question 1** — Which sections to spawn (multiSelect: true):
- **"Implementation agents"** — CODE-REVIEWER, INVESTIGATOR & PLANNER, TEST-WRITER
- **"Management agents"** — PROJECT-MANAGER, DEPUTY-CTO
- **"All sections"** — All 5 sections
- **"Cancel"** — Do nothing

**Question 2** — Concurrency limit (multiSelect: false):
- **"Current default (N)"** — Use the maxConcurrent value from prefetch (Recommended)
- **"5"** — Conservative limit
- **"15"** — Higher limit
- **"20"** — Maximum limit

## Step 3: Spawn via MCP Tool

Map the user's section selection:
- "Implementation agents" → `["CODE-REVIEWER", "INVESTIGATOR & PLANNER", "TEST-WRITER"]`
- "Management agents" → `["PROJECT-MANAGER", "DEPUTY-CTO"]`
- "All sections" → `["CODE-REVIEWER", "INVESTIGATOR & PLANNER", "TEST-WRITER", "PROJECT-MANAGER", "DEPUTY-CTO"]`
- If both "Implementation agents" and "Management agents" selected → combine both arrays
- "Cancel" → stop, do nothing

If the user chose "Other" and typed specific section names, parse those into the array.

Call a single MCP tool:

```
mcp__agent-tracker__force_spawn_tasks({ sections: [...], maxConcurrent: N })
```

## Step 4: Display Results

From the tool response, display:

- **Spawned** (N): list each task title + agent type + PID
- **Skipped** (N): list each with reason (e.g., "concurrency limit reached")
- **Errors** (N): list each with error message

## What This Bypasses

- Automation enabled flag (`autonomous-mode.json`)
- CTO activity gate (24h briefing requirement)
- Task runner cooldown (1h between cycles)
- Task age filter (1h minimum age)
- MAX_TASKS_PER_CYCLE (3 per cycle)

## What This Preserves

- Concurrency guard (configurable via maxConcurrent parameter)
- Task status tracking (marks in_progress, resets on failure)
- Agent tracker registration (spawned agents appear in `/cto-report`)
- Tasks already in_progress are excluded
