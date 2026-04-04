<!-- HOOK:GENTYR:monitor-tasks -->
# /monitor-tasks - Monitor Running Tasks and Persistent Task Monitors

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Enters a continuous monitoring loop that tracks task progress, monitor health, child agent status, demo recordings, user-alignment, and queue capacity. Produces a rich, prescriptive report each round. Stops only when the user interrupts or an intervention-needed condition is detected.

Accepts optional argument: `/monitor-tasks persistent`, `/monitor-tasks <task-id-prefix>`, or bare `/monitor-tasks`.

---

## Step 1: Determine Monitoring Scope

**If the user provided an argument** (e.g., `/monitor-tasks persistent` or `/monitor-tasks 7d2cb0f9`):
- `persistent` → skip to Step 2 with persistent tasks only
- A task ID prefix → skip to Step 3 with that specific task

**Otherwise**, ask:

```
AskUserQuestion: What would you like to monitor?
  - "All active tasks" — monitor all running agents and persistent tasks
  - "Persistent tasks only" — focus on persistent task monitors and their children
```

---

## Step 2: Select Specific Task(s)

### For persistent tasks:

Call `mcp__persistent-task__list_persistent_tasks({})` and display:

```
| # | Title                       | Status  | Cycles | Heartbeat | Monitor |
|---|-----------------------------|---------|--------|-----------|---------|
| 1 | AWS one-click demo E2E      | active  | 204    | 2m ago    | alive   |
| 2 | Refactor auth middleware    | paused  | 50     | 2h ago    | dead    |
```

```
AskUserQuestion: Which task(s) to monitor?
  - "All active" — monitor all active/paused persistent tasks
  - Individual task checkboxes (multiSelect: true)
```

### For all tasks:

Call `mcp__agent-tracker__get_session_queue_status` and display running agents. Ask user to select "All" or specific agents.

---

## Step 3: Initialize Loop State

Before entering the loop, record:
- `roundNumber = 0`
- `criticalMemoryRounds = 0`
- `lastAlignmentRound = 0`
- `demoOfferMade = false`
- `previousCycleCounts = {}` — map of task ID → last seen cycle count
- `previousChildIds = {}` — map of task ID → set of child agent IDs seen last round
- `childErrorPatterns = {}` — map of task ID → list of error strings seen across rounds

---

## Step 4: Monitoring Loop

**IMPORTANT:** You (the main agent) handle the sleep and display loop. Do NOT delegate the loop to a sub-agent.

**MANDATORY SUB-AGENT SPAWNING:** You MUST spawn the investigator sub-agent (Step 4a) EVERY round. You MUST NOT call inspect_persistent_task, peek_session, get_session_queue_status, or other MCP data-gathering tools DIRECTLY. The investigator sub-agent does ALL data gathering. You also MUST spawn the user-alignment sub-agent (Step 4b) every 3rd round. These sub-agents provide the deep analysis that makes the report valuable — skipping them and calling MCP tools directly produces shallow reports.

Each round:
1. Increment `roundNumber`
2. Spawn a short-lived investigator to gather data (Step 4a) — MANDATORY EVERY ROUND
3. Spawn a user-alignment sub-agent (Step 4b) — MANDATORY every 3rd round
4. Render the full report (Step 4c) — using ONLY the data returned by the sub-agents
5. Check intervention conditions (Step 4d)
6. Sleep and repeat (Step 4e)

---

### Step 4a: Gather Data (Investigator Sub-Agent)

Spawn an investigator sub-agent using `Agent(subagent_type='investigator')` with the following prompt. Fill in all `[PLACEHOLDER]` values before spawning.

---

**INVESTIGATOR PROMPT:**

```
You are gathering monitoring data for the /monitor-tasks command. Do a SINGLE analysis pass — gather all data, then return JSON. Do NOT loop or spawn additional agents.

**Persistent tasks to inspect:** [LIST OF TASK IDs]
**Running child agent IDs (from prior round, may be empty):** [LIST OF CHILD AGENT IDs]

## Step A: Inspect each persistent task (REQUIRED)

For EACH persistent task ID:
  mcp__agent-tracker__inspect_persistent_task({
    id: "<task_id>",
    depth_kb: 32,
    running_only: false,
    max_children: 10
  })

From the response, extract:
- task.status, task.cycleCount, task.heartbeat (compute age in minutes)
- task.monitorPid — is it alive? (PID will be in the response)
- task.metadata — check for demo_involved key
- task.lastAssistantText or equivalent verbatim monitor text (the most recent assistant message from the monitor's session)
- For each child: agentId, section, stage (pipeline stage like "code-writer"), progress %, lastTool, elapsed time, stale minutes
- Any error strings visible in JSONL excerpts (lines containing "Error", "failed", "ENOENT", "timeout", "0/N secrets", "Cannot", "rejected")
- Tool calls that FOLLOW those errors (these are the "solutions applied")
- task.subTasks — all sub-tasks with their statuses
- task.amendments — count and acknowledgement status

## Step B: Peek monitor session (REQUIRED for each active task)

For each active persistent task where the monitor PID is known:
  mcp__agent-tracker__peek_session({
    agent_id: "<monitor_agent_id>",
    depth: 16
  })

Extract verbatim lastText (the monitor's most recent reasoning paragraph). This is quoted directly in the report.

## Step C: Peek each running child agent (REQUIRED)

For EACH running child agent ID (from inspect response):
  mcp__agent-tracker__peek_session({
    agent_id: "<child_agent_id>",
    depth: 12
  })

From each response extract:
- lastText: the child's most recent assistant message (verbatim)
- recentTools: last 3-5 tool calls
- errorLines: any lines containing error patterns
- solutionLines: tool calls that immediately follow error lines
- gitState: branch name, commit count, PR number and status if visible

## Step D: Queue health (REQUIRED)

  mcp__agent-tracker__get_session_queue_status({})

Extract: running count, max, memoryPressure level, free RAM (MB), queued count, any persistent lane items queued but not running.

## Step E: Demo recordings (REQUIRED — even if no demo involved)

  Bash("ls -la .claude/recordings/demos/ 2>/dev/null | tail -10 || echo 'NO_RECORDINGS_DIR'")

Record: file names, sizes, modification timestamps. If a file was modified within the last 30 minutes, flag it as "recent".

## Step F: Session activity summaries (REQUIRED)

Gather cross-session activity context from the session-activity broadcaster:

  mcp__session-activity__list_project_summaries({ limit: 3 })

If results returned, get the most recent super-summary:
  mcp__session-activity__get_project_summary({ id: "<most_recent_uuid>" })

Also, for each running child agent, check if there's a recent activity summary:
  mcp__session-activity__list_session_summaries({ session_id: "<agent_id>", limit: 1 })

Extract: the latest project super-summary text, and per-agent summary previews if available. Include these in the JSON response.

## Return ALL data as this exact JSON structure:

{
  "tasks": [
    {
      "id": "...",
      "title": "...",
      "status": "active|paused|completed|cancelled|failed",
      "cycleCount": 204,
      "heartbeatAgeMinutes": 2,
      "heartbeatFreshness": "fresh|aging|stale|DEAD",
      "monitorAgentId": "...",
      "monitorPid": 12345,
      "monitorAlive": true,
      "monitorVerbatim": "Exact last paragraph of monitor's reasoning text...",
      "monitorSummary": "1-2 sentence summary of what the monitor decided/did",
      "demoInvolved": false,
      "amendments": { "total": 2, "unacknowledged": 0 },
      "subTasks": [
        {
          "id": "...",
          "title": "...",
          "status": "pending|in_progress|completed|failed",
          "assignedAgentId": "..." or null,
          "prNumber": 1460 or null,
          "prMerged": true or null
        }
      ],
      "children": [
        {
          "agentId": "...",
          "taskTitle": "...",
          "section": "CODE-WRITER",
          "stage": "code-writer",
          "progress": 42,
          "elapsedMinutes": 28,
          "staleMinutes": 0,
          "lastTool": "Edit",
          "verbatim": "Exact last paragraph of child's reasoning text...",
          "recentTools": ["Edit", "Read", "Bash"],
          "errorLines": ["Error: ENOENT /path/to/file", "Build failed: 3 errors"],
          "solutionLines": ["Bash: mkdir -p /path/to", "Edit: fixed import path"],
          "gitBranch": "feature/fix-demo-config",
          "gitCommits": 2,
          "prNumber": 1461,
          "prStatus": "open|merged|closed|null"
        }
      ],
      "issues": ["description of any detected problems"],
      "cycleDelta": 0
    }
  ],
  "queue": {
    "running": 4,
    "max": 10,
    "queued": 2,
    "memoryPressure": "low|moderate|high|critical",
    "freeMB": 4200,
    "persistentLaneQueued": 0,
    "persistentLaneRunning": 1
  },
  "demoRecordings": [
    {
      "filename": "scenario-abc.mp4",
      "path": ".claude/recordings/demos/scenario-abc.mp4",
      "sizeBytes": 14200000,
      "modifiedMinutesAgo": 5,
      "isRecent": true
    }
  ],
  "sessionActivity": {
    "latestProjectSummary": "Concise unified summary of all session activity from last broadcast..." or null,
    "projectSummaryAge": "5 minutes ago" or null,
    "agentSummaries": [
      {
        "agentId": "...",
        "preview": "120-char preview of what this agent was doing...",
        "summaryId": "uuid for get_session_summary"
      }
    ]
  },
  "interventionNeeded": false,
  "interventionReason": null
}

Return ONLY this JSON. No preamble, no explanation, no markdown fences.
```

---

### Step 4b: User-Alignment Check (Every 3rd Round)

**Check condition:** `(roundNumber % 3 === 0)`

If true, AND there is at least one active persistent task, spawn a user-alignment sub-agent BEFORE rendering the report. Use `Agent(subagent_type='user-alignment')` with this prompt (fill in values):

```
Verify the work on persistent task "[TASK TITLE]" aligns with the CTO's original objective.

Original objective:
[COPY THE FULL TASK DESCRIPTION/PROMPT FROM inspect_persistent_task RESPONSE]

Current state (from this round's data):
- Status: [STATUS], Cycles: [CYCLE COUNT], Heartbeat: [AGE]
- Completed sub-tasks: [LIST COMPLETED SUB-TASK TITLES]
- In-progress sub-tasks: [LIST IN-PROGRESS SUB-TASK TITLES]
- Pending sub-tasks: [LIST PENDING SUB-TASK TITLES]

Recent monitor activity (verbatim):
"[MONITOR VERBATIM TEXT FROM INVESTIGATOR DATA]"

Recent child agent activity (verbatim):
[FOR EACH CHILD: "Agent [ID] ([STAGE]): [CHILD VERBATIM TEXT]"]

Check:
1. Is the work addressing the stated objective? Look for scope drift.
2. Are completed sub-tasks actually relevant to the objective?
3. Are any important parts of the objective being neglected?
4. Is the monitor orchestrating sensibly toward completion?

Return a brief assessment:
- alignment: "aligned" | "drifting" | "misaligned"
- finding: 2-3 sentences of specific evidence for your assessment
- concerns: list of specific concerns (empty list if aligned)
```

Capture the sub-agent's response. Parse `alignment` and `finding` fields. Store `alignmentResult` for use in the report.

If `alignment === "misaligned"`, set `interventionNeeded = true` with reason "User-alignment agent reports misalignment: [finding]".

---

### Step 4c: Render the Report

Render the following report sections in order. Every section is REQUIRED. Do not skip sections even if data is sparse — use "No data available" rather than omitting.

---

```
## Monitor Report — Round [N] ([HH:MM])
```

---

#### Section 1: Task Overview

```
### Task Overview

| Task ID     | Title                          | Status  | Cycles | Δ Cycles | Heartbeat  | Monitor     |
|-------------|--------------------------------|---------|--------|----------|------------|-------------|
| [id prefix] | [title, truncated to 35 chars] | [status]| [N]    | +[delta] | [N]m ago   | [alive/dead]|
```

For `Δ Cycles`: compare current cycle count to `previousCycleCounts[taskId]`. A delta of 0 for 2+ consecutive rounds is a warning sign. Update `previousCycleCounts` after rendering.

Heartbeat freshness labels:
- 0-3 minutes: `fresh`
- 4-10 minutes: `aging`
- 11-30 minutes: `stale [!]`
- 31+ minutes: `DEAD [!!]`

Monitor PID labels:
- Alive: `PID [N] (alive)`
- Dead: `PID [N] (DEAD [!!])` or `unknown (dead [!!])`

---

#### Section 2: Monitor Activity (Verbatim)

```
### Monitor Activity (verbatim)

> "[EXACT QUOTE from monitorVerbatim — do not paraphrase, do not summarize, copy character-for-character]"

[1-2 sentence summary of what the monitor decided or did since the last round, inferred from the verbatim text and cycle delta]
```

If `monitorVerbatim` is empty or unavailable, write: `> [No recent monitor text available — monitor may be sleeping or peek_session returned no assistant messages]`

---

#### Section 3: Child Agents — Detailed Progress

```
### Child Agents — Detailed Progress
```

For EACH child agent in the investigator data:

```
#### Agent [agentId prefix, 8 chars] — [taskTitle, truncated to 40 chars]

- **Stage**: [stage] | **Elapsed**: [N]m | **Progress**: [N]% (if available, else omit)
- **Current action** (verbatim):
  > "[EXACT QUOTE from child verbatim — copy character-for-character]"
- **Challenges**: [List each error line extracted. If none: "None detected this round"]
- **Solutions applied**: [List each solution line — tool calls that followed errors. If none: "None this round"]
- **Git state**: branch `[gitBranch]`, [N] commit(s)[, PR #[N] ([status]) if PR exists]
```

If there are no running child agents:
```
#### No active child agents this round
```

After the per-agent sections, note any NEW child agents (IDs not seen in `previousChildIds`) with: `[NEW] Agent [id] spawned this round`. Note any DEPARTED agents (in `previousChildIds` but not in current data) with: `[DONE] Agent [id] no longer active`. Update `previousChildIds` after rendering.

---

#### Section 4: Task Hierarchy

```
### Task Hierarchy
```

Render a Unicode tree using the `subTasks` array enriched with active child agent data. Use these symbols:

- `[done]` — completed sub-task
- `[active]` — in_progress sub-task
- `[pending]` — pending sub-task
- `[FAILED]` — failed sub-task

Format:

```
[*] Persistent Task: [TITLE]
├── [done] [Sub-task title] (completed[, PR #N merged])
├── [active] [Sub-task title] (in_progress)
│   └── Agent [agentId prefix] ([N]m, [last tool or verbatim excerpt ≤50 chars])
├── [pending] [Sub-task title] (pending)
└── [pending] [Sub-task title] (pending)
```

If a sub-task has no child agent but is in_progress, show it as `[active] [title] (in_progress, no active agent [!])`.

If `amendments.unacknowledged > 0`, add a line after the tree:
```
[!] [N] unacknowledged amendment(s) — monitor has not yet processed CTO input
```

---

#### Section 5: Challenges & Solutions Log

```
### Challenges & Solutions Log

| Time  | Agent              | Challenge                              | Resolution                        | Outcome     |
|-------|--------------------|----------------------------------------|-----------------------------------|-------------|
| [HH:MM] | Agent [id prefix] | [error line, truncated to 45 chars]  | [solution line, truncated to 35c] | [inferred]  |
```

Extract from the `errorLines` and `solutionLines` arrays in the investigator data. For each error line, pair it with the corresponding solution line (same index) if available.

Infer outcome:
- If a solution line exists and no repeat of the same error: `resolved`
- If the same error appeared in a prior round: `recurring [!]`
- If no solution found: `open`

Update `childErrorPatterns[taskId]` with any new error strings seen this round. If the same error string has appeared in 3+ consecutive rounds across any children of the same task, add it to `issues` and set intervention flag per Step 4d.

If no challenges detected: write a single row with `—` in Challenge column and `"No errors detected this round"` in Resolution.

---

#### Section 6: Demo Status

```
### Demo Status
```

Always render this section. Check `demoInvolved` from the task metadata AND check `demoRecordings` from the investigator data.

If `demoInvolved === true`:
```
Demo recording active for this task.
```

If `demoRecordings` is non-empty:
```
| Recording                    | Size    | Last Modified  | Status   |
|------------------------------|---------|----------------|----------|
| [filename, truncated to 30c] | [N] MB  | [N] min ago    | [recent/old] |
```

If a recording has `isRecent === true` AND `demoOfferMade === false`:
```
Recording updated [N] minutes ago. Would you like me to open it?
```
Set `demoOfferMade = true`. Use `AskUserQuestion` only once per session — if the user says yes, call `mcp__playwright__open_video({ path: "[recording path]" })`.

If no recordings and no demo involvement:
```
No demo recordings found. Task does not involve demo scenarios.
```

---

#### Section 7: User Alignment (Every 3rd Round)

```
### User Alignment
```

If `roundNumber % 3 === 0` and alignment check was performed (Step 4b):
```
**Alignment**: [aligned [done] | drifting [!] | misaligned [!!]]

[alignmentResult.finding — copy verbatim from sub-agent response]

[If concerns list non-empty:]
**Concerns:**
- [concern 1]
- [concern 2]
```

If not a 3rd round:
```
Next alignment check: Round [next multiple of 3]. ([rounds until check] rounds away)
```

---

#### Section 8: Queue Health

```
### Queue Health

| Running / Max | Memory Pressure | Free RAM   | Queued | Persistent Lane |
|---------------|-----------------|------------|--------|-----------------|
| [N] / [N]     | [level]         | [N] MB     | [N]    | [Q queued, R running] |
```

Memory pressure color indicators (rendered as text labels):
- `low` → `low [done]`
- `moderate` → `moderate [!]`
- `high` → `high [!][!]`
- `critical` → `critical [!!]`

If `memoryPressure === "critical"`, increment `criticalMemoryRounds`. If `memoryPressure !== "critical"`, reset `criticalMemoryRounds = 0`.

---

#### Section 9: Cross-Session Activity

```
### Cross-Session Activity
```

If `sessionActivity.latestProjectSummary` is available:
```
**Latest project summary** ([age]):
> "[project summary text — verbatim from broadcaster]"
```

If `sessionActivity.agentSummaries` has entries, list them:
```
**Agent activity snapshots:**
- Agent [id prefix]: [preview] (details: `mcp__session-activity__get_session_summary({ id: "[summaryId]" })`)
```

If no session activity data available:
```
Session activity broadcaster not yet running or no summaries available. Deploy with `npx gentyr sync && scripts/setup-automation-service.sh setup`.
```

If related work detected between monitored task and other sessions, add:
```
[!] **Coordination opportunity**: [description of overlap]. Consider using `mcp__agent-tracker__send_session_signal` to coordinate.
```

---

#### Section 10: Assessment

```
### Assessment
```

Write a **detailed multi-sentence assessment** (minimum 4 sentences). This section MUST contain specific evidence from the data gathered this round. Do NOT write vague summaries like "Everything looks healthy." Instead:

- State the monitor's current operational status with specific cycle count and heartbeat data
- Describe what milestone or sub-task was most recently completed (with PR numbers if applicable)
- Describe what is currently in progress and what specific action the child agent is performing
- State what the next expected milestone is based on the pending sub-tasks
- Highlight any concerns (stale heartbeat, zero cycle delta, recurring errors, unacknowledged amendments) with specific data
- End with one of these verdict lines:

```
[done] Healthy — [specific reason with data]
[!] Warning — [specific concern with data]
[!!] INTERVENTION NEEDED — [specific reason with data]
```

---

### Step 4d: Check Intervention Conditions

After rendering the report, evaluate these conditions. Stop the loop if ANY are true and display the stop block below.

**Condition 1 — Monitor dead, no revival queued**
- `monitorAlive === false` AND `persistentLaneQueued === 0`
- Reason: "Monitor PID [N] is dead and no revival is queued in the persistent lane."

**Condition 2 — Task self-paused**
- Task `status === "paused"` (and it was `active` in a prior round)
- Reason: "Task transitioned to paused — monitor escalated a blocker. Review task amendments."

**Condition 3 — Task completed or cancelled**
- Task `status === "completed"` or `status === "cancelled"`
- Reason: "Task reached terminal state: [status]. Objective [achieved/abandoned]."

**Condition 4 — Critical memory pressure 3+ rounds**
- `criticalMemoryRounds >= 3`
- Reason: "Critical memory pressure for [N] consecutive rounds — persistent monitor revival may be blocked."

**Condition 5 — Child agent stale 15+ minutes**
- Any child with `staleMinutes >= 15`
- Reason: "Agent [id] has been stale for [N] minutes with no tool calls — possible hang."

**Condition 6 — Systemic error pattern**
- Same error string seen in 3+ consecutive rounds across 3+ different children of the same task
- Reason: "Systemic error detected across [N] agents: '[error string]'. Infrastructure or environment issue likely."

**Condition 7 — User-alignment misaligned**
- `alignmentResult.alignment === "misaligned"` (set in Step 4b)
- Reason: "User-alignment agent reports misalignment: [alignmentResult.finding]"

When stopping, display:

```
---
[!!] MONITORING STOPPED — Round [N]

**Reason:** [condition reason]

**Recommended action:**
- [Condition 1]: Call mcp__persistent-task__resume_persistent_task({ id: "[task_id]" }) to trigger immediate revival.
- [Condition 2]: Review task details with mcp__persistent-task__get_persistent_task({ id: "[task_id]" }). Check amendments for the escalation reason.
- [Condition 3]: Review completed work. Call mcp__persistent-task__get_persistent_task_summary({ id: "[task_id]" }) for a full report.
- [Condition 4]: Check memory with mcp__agent-tracker__get_session_queue_status. Kill unnecessary sessions to free RAM.
- [Condition 5]: Inspect the stale agent with mcp__agent-tracker__peek_session({ agent_id: "[id]", depth: 24 }). Consider killing and re-creating the task.
- [Condition 6]: Investigate infrastructure. Check secrets resolution, dev server health, and network connectivity.
- [Condition 7]: Amend the persistent task with mcp__persistent-task__amend_persistent_task to provide corrective direction.

Last report data is above. Resume monitoring with /monitor-tasks [task-id-prefix] after addressing the issue.
```

---

### Step 4e: Sleep and Repeat

If no intervention condition triggered:

```
---
Sleeping 60s before Round [N+1]... (use Ctrl+C or send a message to stop)
```

Execute `Bash("sleep 60")`, then return to Step 4 (increment `roundNumber` and repeat).

---

## Notes and Anti-Patterns

**DO NOT:**
- Skip any report section, even if data is sparse
- Paraphrase verbatim quotes — copy them character-for-character
- Write "No issues" in the Assessment without citing specific data points
- Delegate the sleep loop to a sub-agent — only the investigator and user-alignment are spawned as sub-agents
- Call `inspect_persistent_task`, `peek_session`, `get_session_queue_status`, `get_comms_log`, or `session-activity` tools directly — ALL data gathering goes through the investigator sub-agent
- Skip spawning the investigator sub-agent and call MCP tools yourself — this produces shallow reports
- Use `AskUserQuestion` for the demo offering more than once per monitoring session

**DO:**
- Track state between rounds (cycle deltas, child ID churn, error pattern recurrence, criticalMemoryRounds)
- Treat a cycle delta of 0 for 2+ rounds as a warning worth noting in Assessment
- Treat a new child agent ID replacing a departed one as evidence of a prior failure (note in Section 3)
- Quote the most diagnostic sentence from verbatim text when it is long — prefer the sentence that explains a decision or describes a blocker
- If `inspect_persistent_task` is slow (>30s), note this in the Assessment as a potential MCP tool health issue

**Investigator completion time target:** Under 45 seconds. If the investigator takes longer, note it.

**Round numbering:** Start at 1. Increment before rendering (so the first report says "Round 1").
