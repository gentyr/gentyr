<!-- HOOK:GENTYR:spawn-tasks -->
# /spawn-tasks - Unified Agent Spawning

On-demand command to **spawn agents immediately**. Supports two modes:

- **Bare mode** (`/spawn-tasks`): Browse and spawn existing pending tasks by section
- **Description mode** (`/spawn-tasks <description>`): Create new tasks from plain English, then spawn them

The prefetch hook has pre-gathered pending task counts, running agent info, and concurrency limits, injected as `[PREFETCH:spawn-tasks]` context above. Use that data for Step 1.

## Step 1: Display Current State (Both Modes)

From the prefetch data, display a summary table:

| Section | Pending Tasks |
|---------|--------------|
| CODE-REVIEWER | N |
| INVESTIGATOR & PLANNER | N |
| TEST-WRITER | N |
| PROJECT-MANAGER | N |
| DEPUTY-CTO | N |
| PRODUCT-MANAGER | N |
| **Total** | **N** |

Also show: **Running agents**: N / M (N running, M max concurrent, K available slots)

## Step 2: Determine Mode

Check if the user provided a description after `/spawn-tasks`:
- **No description** (bare `/spawn-tasks`) → Go to **Mode A** (Section Selection)
- **Description provided** (e.g., `/spawn-tasks refactor the auth module`) → Go to **Mode B** (Description)

---

## Mode A: Section Selection (Existing Behavior)

### Step A2: Ask User

Use AskUserQuestion with **two questions**:

**Question 1** — Which sections to spawn (multiSelect: true):
- **"Implementation agents"** — CODE-REVIEWER, INVESTIGATOR & PLANNER, TEST-WRITER
- **"Management agents"** — PROJECT-MANAGER, DEPUTY-CTO, PRODUCT-MANAGER
- **"All sections"** — All 6 sections
- **"Cancel"** — Do nothing

### Step A3: Spawn via MCP Tool

Map the user's section selection:
- "Implementation agents" → `["CODE-REVIEWER", "INVESTIGATOR & PLANNER", "TEST-WRITER"]`
- "Management agents" → `["PROJECT-MANAGER", "DEPUTY-CTO", "PRODUCT-MANAGER"]`
- "All sections" → `["CODE-REVIEWER", "INVESTIGATOR & PLANNER", "TEST-WRITER", "PROJECT-MANAGER", "DEPUTY-CTO", "PRODUCT-MANAGER"]`
- If both "Implementation agents" and "Management agents" selected → combine both arrays
- "Cancel" → stop, do nothing

If the user chose "Other" and typed specific section names, parse those into the array.

Call:
```
mcp__agent-tracker__force_spawn_tasks({ sections: [...] })
```

Then go to **Step 5: Display Results & Monitor**.

---

## Mode B: Description (Natural Language)

### Step B2: Parse Description into Task Specs

Parse the plain English description into 1-N task specs. Use this section heuristic:

| User intent | Section |
|---|---|
| Code changes, features, bug fixes, refactoring | `CODE-REVIEWER` |
| Research, analysis, investigation | `INVESTIGATOR & PLANNER` |
| Test creation, coverage improvements | `TEST-WRITER` |
| Documentation, cleanup, project tasks | `PROJECT-MANAGER` |
| Strategic, cross-cutting orchestration | `DEPUTY-CTO` |
| Product analysis, personas, PMF | `PRODUCT-MANAGER` |

For ambiguous descriptions, prefer `CODE-REVIEWER` (triggers full agent sequence: investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager).

For complex requests, split into multiple tasks (e.g., "refactor auth and add tests" → one CODE-REVIEWER task + one TEST-WRITER task).

### Step B3: Confirm with User

Use AskUserQuestion to show the proposed task(s):

```
I'll create the following task(s):

1. [CODE-REVIEWER] Refactor the auth module
   Description: Investigate and refactor the authentication module...

2. [TEST-WRITER] Add auth module test coverage
   Description: Create comprehensive tests for the auth module...
```

Options:
- **"Create & spawn"** (Recommended) — Create tasks and spawn agents immediately
- **"Create only"** — Create tasks but don't spawn (picked up by hourly automation)
- **"Edit"** — Let me modify the tasks first
- **"Cancel"** — Do nothing

If user selects "Edit", ask them to describe changes and regenerate the task list.

### Step B4: Create & Spawn

For each proposed task, create it:
```
mcp__todo-db__create_task({
  section: "<section>",
  title: "<title>",
  description: "<description>",
  assigned_by: "human",
  priority: "normal"
})
```

Collect all created task IDs.

If user chose "Create & spawn", spawn them:
```
mcp__agent-tracker__force_spawn_tasks({ taskIds: ["<id1>", "<id2>", ...] })
```

Then go to **Step 5: Display Results & Monitor**.

---

## Step 5: Display Results & Monitor

### Display Spawn Results

From the `force_spawn_tasks` response, display:

- **Spawned** (N): list each task title + agent type + PID
- **Skipped** (N): list each with reason (e.g., "concurrency limit reached")
- **Errors** (N): list each with error message

### Monitor Loop

If any agents were spawned, collect their `agentId` values from the response and poll for status:

1. Wait ~15 seconds
2. Call `mcp__agent-tracker__monitor_agents({ agentIds: [...] })`
3. Display a status table:

```
| Agent | Section | Task | Status | Elapsed |
|-------|---------|------|--------|---------|
| code-reviewer-abc | CODE-REVIEWER | Refactor auth | running | 2m 15s |
| test-writer-def | TEST-WRITER | Add auth tests | completed | 4m 30s |

Progress: 1/2 complete (1 still running)
```

4. If `allComplete: true` → display final summary and stop
5. If elapsed > 10 minutes → display message that agents continue in background and stop monitoring
6. Otherwise → repeat from step 1

Format elapsed time as: `Xs` (under 60s), `Xm Ys` (under 60m), `Xh Ym` (over 60m).

## What This Bypasses

- Automation enabled flag (`autonomous-mode.json`)
- CTO activity gate (24h briefing requirement)
- Task runner cooldown (1h between cycles)
- Task age filter (1h minimum age)
- MAX_TASKS_PER_CYCLE (3 per cycle)

## What This Preserves

- Concurrency guard (reads configured limit from session queue; change via `set_max_concurrent_sessions`)
- Task status tracking (marks in_progress, resets on failure)
- Agent tracker registration (spawned agents appear in `/cto-report`)
- Tasks already in_progress are excluded
- Task gate system (tasks from `assigned_by: "human"` bypass gate)
