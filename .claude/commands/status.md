<!-- HOOK:GENTYR:show -->
# /status -- Comprehensive System Status Report

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Produces a layered, comprehensive system status report. Starts with an executive summary, then drills into every layer: plans, persistent tasks, todo-db tasks, session queue, bypass requests, and -- most importantly -- a deep investigator-driven analysis of every active session.

Accepts optional argument: `/status plans`, `/status persistent`, `/status <plan-id-prefix>`, `/status <task-id-prefix>`, or bare `/status`.

One-shot -- no sleep/repeat cycle, no state file, no reminder hook.

---

## Step 1: Determine Scope

**If argument is `plans`** -> focus on plans
**If argument is `persistent`** -> focus on persistent tasks
**If argument looks like a plan ID** -> focus on that specific plan
**If argument is a task ID prefix** -> focus on that specific persistent task
**Otherwise** -> show everything (plans + persistent tasks + tasks + queue + sessions)

For plan selection, call `mcp__plan-orchestrator__list_plans({})` and show a selection table.
For persistent task selection, call `mcp__persistent-task__list_persistent_tasks({})` and show a selection table.

Do NOT call `update_monitor_state` or write any state files.

---

## Step 2: Fast Data Gather (YOU call MCP tools directly)

Call all of these in parallel where possible to minimize latency.

### Step 2a: QUEUE STATUS

```
mcp__agent-tracker__get_session_queue_status({})
```

Extract: running count, max concurrent, queued count, suspended count, memory pressure level, automated vs standard running, available slots, focus mode, reserved slots.

### Step 2b: PLANS

```
mcp__plan-orchestrator__list_plans({ status: 'active' })
```

For each active plan:
```
mcp__plan-orchestrator__plan_dashboard({ plan_id: "<id>" })
```

For plans with paused tasks or low progress:
```
mcp__plan-orchestrator__get_plan_blocking_status({ plan_id: "<id>" })
mcp__plan-orchestrator__get_spawn_ready_tasks({ plan_id: "<id>" })
```

### Step 2c: PERSISTENT TASKS

```
mcp__persistent-task__list_persistent_tasks({})
```

For each active/paused persistent task:
```
mcp__agent-tracker__inspect_persistent_task({ id: "<task_id>" })
```

### Step 2d: TODO-DB TASKS

```
mcp__todo-db__list_tasks({ status: 'in_progress', limit: 30 })
mcp__todo-db__list_tasks({ status: 'pending', limit: 30 })
mcp__todo-db__list_tasks({ status: 'pending_audit', limit: 10 })
mcp__todo-db__list_tasks({ status: 'pending_review', limit: 10 })
```

### Step 2e: BYPASS REQUESTS & BLOCKING

```
mcp__agent-tracker__list_bypass_requests({ status: 'pending' })
mcp__agent-tracker__get_blocking_summary({})
```

### Step 2f: RECENT COMPLETIONS

```
mcp__todo-db__list_tasks({ status: 'completed', limit: 10 })
```

### Step 2g: GLOBAL MONITOR

Find the global deputy-CTO monitor persistent task and its running session:

1. From the persistent tasks list (Step 2c), find the task with `task_type: "global_monitor"` in its metadata
2. From the queue status (Step 2a), find the running session in the `persistent` lane with matching `persistentTaskId`
3. If a running monitor session exists, note its `agent_id` for the investigator prompt in Step 3

If no global monitor task exists or it's disabled/paused, note the state for Section 9.

---

## Step 3: Spawn Session Investigator

Spawn **ONE** investigator sub-agent to deeply analyze active sessions. This is the most valuable part of the report -- the investigator reads actual session content, not summaries.

**Scope filtering:** If `/status` was invoked with a scope argument (Step 1), only include sessions relevant to that scope in the investigator prompt:
- `/status plans` or `/status <plan-id>` -> only sessions linked to the selected plan(s) (plan-manager monitors + their children)
- `/status persistent` or `/status <task-id>` -> only the selected persistent task's monitor + its children
- bare `/status` -> all running sessions

**Render Step 2 data BEFORE spawning the investigator.** Output Sections 1-5 and 7 from Step 4 using the structural data you already have. Then spawn the investigator. When it returns, output Section 6 (Session Deep Dive), Section 8 (Assessment), and Section 9 (Global Monitor Review).

```javascript
Agent({
  subagent_type: "investigator",
  description: "Deep session analysis for /status",
  prompt: `[STATUS INVESTIGATION] Comprehensively analyze the active Claude sessions listed below and return a structured report.

## Your Job

You are gathering detailed intelligence on active sessions for a CTO status report. For each session, you must understand: what the agent is CURRENTLY doing, what it has RECENTLY accomplished, what problems it's facing, and whether it's making progress or stuck.

## Sessions to Investigate

// Dynamically construct this list from Step 2a queue status data.
// Include: agent_id, agent_type, title, persistent_task_id (if any),
// worktree_path (if any), queue_id, priority, lane, uptime.
// Filter by scope if a scope argument was provided to /status.
${JSON.stringify(filteredRunningSessions)}

## Investigation Steps (for EACH running session)

### 1. Browse Recent Session Messages
\`\`\`
mcp__agent-tracker__browse_session({ agent_id: "<agent_id>", page_size: 30 })
\`\`\`
Read the last 30 messages. If they're all sleep/polling/heartbeat, page backward:
\`\`\`
mcp__agent-tracker__browse_session({ agent_id: "<agent_id>", page_size: 30, before_index: <first_index> })
\`\`\`
Keep paging until you find substantive work (tool calls, text reasoning, errors).

### 2. Peek Session Tail (for context beyond browse)
\`\`\`
mcp__agent-tracker__peek_session({ agent_id: "<agent_id>", depth: 16, include_compaction_context: true })
\`\`\`
Check for compaction (context loss), error patterns, and recent tool call results.

### 3. Deep Inspect Persistent Task (if monitor session)
\`\`\`
mcp__agent-tracker__inspect_persistent_task({ id: "<persistent_task_id>", depth_kb: 32, running_only: false, max_children: 10 })
\`\`\`
This gives you the monitor's cycle count, heartbeat, last_summary, children status, plan linkage, and amendment state.

### 4. Check Session Activity Summaries
\`\`\`
mcp__session-activity__list_session_summaries({ session_id: "<session_id>" })
\`\`\`
Get the LLM-generated activity summary for cross-reference.

### 5. Check Worktree State (if agent has a worktree)
For agents running in worktrees, check git state:
\`\`\`
Bash: cd <worktree_path> && git log --oneline -5 && git status --short && git diff --stat origin/preview...HEAD 2>/dev/null || true
\`\`\`
This reveals: how many commits the agent has made, whether there are uncommitted changes, and how far ahead of the base branch it is.

### 6. Check Progress File (if spawned agent)
\`\`\`
Read: .claude/state/agent-progress/<agent_id>.json
\`\`\`
Shows pipeline stage (e.g., investigator, code-writer, test-writer), progress %, completed stages, and PR status.

### 7. Check Demo State (if demo-involved session)
\`\`\`
Bash: ls -la .claude/recordings/demos/ 2>/dev/null | head -20
\`\`\`
Look for recent recordings, screenshots, and check_demo_result data.

### 8. Global Monitor Deep Dive (if running)

If one of the sessions is the global deputy-CTO monitor (identified by \`GENTYR_DEPUTY_CTO_MONITOR=true\` in env or \`task_type: "global_monitor"\` persistent task), give it EXTRA attention:

\`\`\`
mcp__agent-tracker__browse_session({ agent_id: "<monitor_agent_id>", page_size: 50 })
\`\`\`

Page backward through history to find:
- **Bypass requests triaged**: Any \`deputy_resolve_bypass_request\` or \`deputy_escalate_to_cto\` calls
- **Alignment signals sent**: Any \`send_session_signal\` calls to other agents
- **Correction tasks created**: Any \`create_task\` calls for misalignment fixes
- **Zombies killed**: Any \`kill_session\` calls
- **Audit gate interventions**: Any stuck \`pending_audit\` detections

Count each action type across the session history. If the monitor has been running for hours, page backward at least 3 times to capture a representative sample of its activity.

### 9. Check for Sub-Agents (for sessions that appear idle but alive)
If peek_session returns an \`activeSubagents\` array, the session has Agent tool sub-agents running inside it.
For each sub-agent listed:
- Note its agentType, description, fileSize, lineCount, and lastTimestamp
- For the most recent/largest sub-agent, call peek_session with subagent_id parameter to see its activity:
  \`mcp__agent-tracker__peek_session({ agent_id: "<parent_agent_id>", subagent_id: "<sub_agent_id>", depth: 16 })\`
- Report what the sub-agent is doing (last tools, last text, activity pattern)
A session that appears "idle" may actually have a very active sub-agent — check before concluding it's stuck.

## Output Format

Return a SINGLE structured report with this exact format for each session:

---
### Session: <agent_id> -- <agent_type> -- <title or task>
**Status:** running | stuck | erroring | idle | completing
**Uptime:** Xh Ym
**Pipeline Stage:** <stage> (<progress>%)
**Worktree:** <branch> | <N commits> | <uncommitted changes Y/N> | <PR status>

**Current Activity** (from browse_session):
Quote the 3-5 most informative recent messages verbatim with their indices:
  #NNN [HH:MM:SS] [type] <content>

**Recent Accomplishments:**
- Bullet list of concrete work done (files changed, PRs created, tests passing, etc.)

**Problems/Errors Detected:**
- Any error messages, retries, stuck loops, or blocked states from the session
- Include specific error text if found

**Monitor Insights** (persistent task monitors only):
- Cycle count, heartbeat age, last_summary text
- Child session statuses
- Amendment state (any unacknowledged?)

**Sub-Agents:** (if activeSubagents detected)
  - <sub_agent_id> (<agentType>) — <lineCount> lines, <fileSize>, last active <age> — [activity summary from subagent peek]

**Compaction:** Yes/No (if yes, note context loss)
**Assessment:** 1-sentence verdict -- healthy/progressing/stuck/needs-intervention
---

## Rules
- Do NOT create tasks, write files, or modify anything
- Do NOT skip sessions -- investigate ALL of them
- Do NOT summarize session messages in your own words for the "Current Activity" section -- quote them verbatim with indices
- If a session's browse output is pure polling/sleep, say so and show the last substantive messages instead
- Be specific: cite message indices, error text, file paths, PR numbers
- If there are 0 running sessions, say so and check for recently completed sessions instead
`
})
```

**Important:** Construct the prompt dynamically using the running session list from Step 2a. Include agent IDs, agent types, persistent task IDs, worktree paths, and queue item metadata in the prompt so the investigator knows exactly what to inspect. Apply scope filtering from Step 1 -- do NOT send the investigator to analyze sessions unrelated to the user's requested scope.

---

## Step 4: Render the Report

You already rendered Sections 1-5 and 7 BEFORE spawning the investigator (per Step 3 instructions). Now that the investigator has returned, render Section 6 (Session Deep Dive), Section 8 (Assessment), and Section 9 (Global Monitor Review).

### Section 1: Executive Summary

3-5 bullet points covering the most important facts. Lead with problems/blockers, then progress, then health:

```
## Executive Summary

- **BLOCKER**: 2 pending CTO bypass requests (Evidence Viewer credentials, staging lock override)
- Plan "Release v2.3" at 67% -- Phase 3 verification running, Phase 4 blocked on demo pass
- 4 agents running (2 monitors + 2 task runners), queue at 4/48, memory low
- 3 tasks completed in last 2 hours (auth timeout fix, HIPAA gate, attestation FK)
- System healthy -- no stuck sessions, no stale heartbeats
```

### Section 2: System Health

```
## System Health

Queue: 4/48 running (2 standard + 2 automated) | 0 queued | 0 suspended
Memory: low (4485MB free) | Spawning: unrestricted
Focus Mode: off | Reserved Slots: 0
Automation Toggles: all enabled (or list any disabled)

Git:
- preview: 3 commits ahead of main (last: 6ae4bb3 "fix auth timeout" 25m ago)
- staging: in sync with main
- Active worktrees: 2 (.claude/worktrees/feature/fix-auth, .claude/worktrees/feature/demo-repair)
```

### Section 3: Plans (if any active)

```
## Plans

### Release v2.3 (plan-abc123)
Progress: 67% | Phases: 3/5 | Tasks: 8/12 done | Ready to spawn: 2
Manager: persistent-task pt-xyz (alive, heartbeat 1m ago)

Phase 1: Setup           [========] 100% COMPLETED
Phase 2: Implementation  [========] 100% COMPLETED
Phase 3: Verification    [====    ]  50% IN PROGRESS
  - task-001: Run full test suite        COMPLETED (audit passed)
  - task-002: Demo validation batch      IN PROGRESS (monitor pt-demo)
  - task-003: Security audit             PENDING_AUDIT (auditor spawned 3m ago)
Phase 4: Triage           [        ]   0% BLOCKED (depends on Phase 3)
Phase 5: CTO Sign-off     [        ]   0% PENDING

Blocking: Phase 3 task-002 in progress, 0 parallel paths available
Ready to spawn: task-003 auditor (already spawned)
```

### Section 4: Persistent Tasks

```
## Persistent Tasks

| Task | Status | Monitor | Heartbeat | Children | Last Summary |
|------|--------|---------|-----------|----------|--------------|
| Evidence Viewer build | active | alive (pid 12345) | 2m ago | 1 running | "Extending build prereq scope to global" |
| Phase 4 batch runner | active | alive (pid 12346) | 1m ago | 0 | "Running 27-scenario batch, 14/27 complete" |

### Evidence Viewer build (pt-abc123)
Cycles: 45 | Created: 2h ago | Plan: Release v2.3 Phase 3 Task 2
Last Summary: "Extending @acme/ui build prerequisite to RECORD demos globally.
Fixed scenario-scoped prerequisite that was missing from headed runs."
Amendments: 0 pending
Children: 1 running (task-5c0140a9 "Fix build prereq scope")
```

### Section 5: Active Tasks

```
## Active Tasks (in_progress)

| ID | Title | Category | Priority | Age | Session | Progress |
|----|-------|----------|----------|-----|---------|----------|
| 5c0140a9 | Fix build prereq scope | Standard Dev | normal | 25m | agent-abc | code-writer 60% |
| 2b5d8b8a | Phase 4 RETRY batch | Demo Design | urgent | 25m | agent-def | demo-manager 40% |

## Pending Tasks (ready to spawn)

| ID | Title | Category | Priority | Age | Blocked By |
|----|-------|----------|----------|-----|------------|
| (none) | | | | | |

## Pending Audit

| ID | Title | Auditor | Age |
|----|-------|---------|-----|
| e39069ae | HIPAA backend check | auditor-ghi | 5m |

## Recently Completed (last 2 hours)

| ID | Title | Completed | Audit |
|----|-------|-----------|-------|
| 64570625 | Attestation Chain FK | 45m ago | passed |
| d08b579c | Redaction Comparison | 1h ago | passed |
```

### Section 6: Session Deep Dive (from investigator)

Insert the investigator's full per-session report here. This is the core of the status report.

```
## Session Deep Dive

### Session: agent-abcdefgh -- code-writer -- Fix build prereq scope
**Status:** progressing
**Uptime:** 25m
**Pipeline Stage:** code-writer (60%)
**Worktree:** feature/fix-build-prereq | 2 commits | no uncommitted | no PR yet

**Current Activity:**
  #142 [11:55:30] [text] The prerequisite is currently scenario-scoped. I need to move it to global scope...
  #143 [11:55:31] [tool] Read .claude/hooks/lib/demo-prerequisites.js
  #144 [11:55:45] [tool] Edit .claude/hooks/lib/demo-prerequisites.js
  #145 [11:56:02] [text] Now I need to update the test to verify global scope...
  #146 [11:56:03] [tool] Read .claude/hooks/__tests__/demo-prerequisites.test.js

**Recent Accomplishments:**
- Identified root cause: prerequisite registered with scope='scenario' instead of scope='global'
- Edited demo-prerequisites.js to change scope
- 2 commits on feature branch

**Problems/Errors Detected:**
- None detected

**Compaction:** No
**Assessment:** Healthy -- actively editing code, on track

---

### Session: agent-defghijk -- persistent-monitor -- Phase 4 RETRY batch
**Status:** running (polling)
**Uptime:** 25m
**Pipeline Stage:** demo-manager (40%)
**Worktree:** N/A (monitor in main tree)

**Current Activity:**
  #89 [11:58:00] [tool] mcp__playwright__check_demo_batch_result({ batch_id: "batch-xyz" })
  #90 [11:58:15] [text] Batch progress: 14/27 scenarios complete. 12 passed, 2 failed...
  #91 [11:58:16] [tool] mcp__persistent-task__heartbeat({ id: "pt-batch" })
  #92 [11:58:30] [text] Checking failed scenarios: login-flow (timeout), dashboard-nav (element not found)...

**Recent Accomplishments:**
- Spawned batch run with all 27 scenarios on Fly.io
- 12/27 passing so far
- Previously spawned fix tasks for 3 failing scenarios (all completed)

**Problems/Errors Detected:**
- 2 scenarios failing: login-flow (timeout after 60s), dashboard-nav (element not found)
- login-flow has failed 2 previous attempts -- may need investigation

**Monitor Insights:**
- Cycles: 12 | Heartbeat: 1m ago
- Last Summary: "Running full 27-scenario batch. 12 passed, 2 failed, 13 pending."
- No amendments pending

**Compaction:** No
**Assessment:** Progressing -- batch running, 2 persistent failures may need escalation

---

### Session: agent-abc12345 -- task-runner -- "Fix 17 ALLOW demos"
**Status:** running (sub-agent active)
**Uptime:** 45m
**Pipeline Stage:** demo-manager (40%)
**Worktree:** feature/fix-allow-demos | 0 commits | no uncommitted | no PR yet

**Current Activity:**
  #88 [11:30:00] [tool] Agent({ subagent_type: "demo-manager", ... })
  (parent session idle since spawning sub-agent 15m ago)

**Sub-Agents:**
  - agent-a125e76d (demo-manager) — 516 lines, 1.1MB, last active 3m ago — polling check_demo_batch_result, 8/17 scenarios complete
  - agent-ace0538e (code-writer) — 42KB, completed 2h ago

**Problems/Errors Detected:**
- None -- parent appears idle but sub-agent is actively polling batch results

**Compaction:** No
**Assessment:** Healthy -- parent idle but sub-agent actively running batch demos
```

### Section 7: Blockers & Bypass Requests

```
## Blockers & Bypass Requests

### Pending CTO Bypass Requests: 0
(none)

### Active Blocking Queue Items: 0
(none)
```

### Section 8: Assessment & Verdict

Synthesize everything into a comprehensive assessment. Be specific -- reference plan progress percentages, session message indices, error text, PR numbers, and task IDs.

```
## Assessment

**System State:** 2 focused sessions running in a clean queue (4/48 capacity).
Memory pressure is low. No bypass requests pending. No blocking items.

**Plan Progress:** Release v2.3 at 67%. Phase 3 verification is the active front --
the Evidence Viewer build prereq fix (agent-abcdefgh) is at code-writer stage 60%
and should complete within ~15 minutes. The Phase 4 batch (agent-defghijk) has 14/27
scenarios done with 2 persistent failures (login-flow timeout, dashboard-nav element
not found) that may need manual investigation if the current batch completes with
those still failing.

**Risk:** The login-flow scenario has failed 3 times across different batches. This
is the primary risk to Phase 4 completion. If the current batch finishes with that
scenario still failing, recommend spawning a dedicated investigator for root cause.

**Recent Progress:** 5 tasks completed since last check, showing healthy throughput.
The system cleaned up from 14 sessions to 2 -- most fix tasks resolved successfully.

**Verdict: Healthy -- 2 focused sessions, good progress, 1 scenario risk to watch**
```

### Section 9: Global Monitor Review

This is the FINAL section of the report. It reviews what the global deputy-CTO alignment monitor has been doing.

**If the global monitor is not running** (disabled, paused, no task, or dead PID):

```
## Global Monitor

Status: DISABLED / PAUSED / INACTIVE / DEAD (no running session)
(Show task ID and state if applicable. Recommend `/global-monitor on` if inactive.)
```

**If the global monitor IS running** (from the investigator's Step 8 data):

```
## Global Monitor

Status: ACTIVE (pid <PID>, heartbeat <age>)
Task ID: <task_id>
Uptime: <session uptime>

### Activity Summary (from session history)

| Action | Count | Last Occurrence |
|--------|-------|-----------------|
| Bypass requests triaged | N | Xm ago |
| Alignment signals sent | N | Xm ago |
| Correction tasks created | N | Xm ago |
| Zombies killed | N | Xm ago |
| Audit gate interventions | N | never |

### Recent Actions (last 3-5 substantive actions, verbatim from session)

  #NNN [HH:MM:SS] [tool] deputy_resolve_bypass_request({ request_id: "...", decision: "approved" })
  #NNN [HH:MM:SS] [tool] send_session_signal({ agent_id: "...", signal: { type: "directive", ... } })
  #NNN [HH:MM:SS] [text] "Checked 4 active tasks against CTO intent. All aligned."

### Monitor Health

- Cycles completed: N (from inspect_persistent_task)
- Signal throttle: N signals in last hour (threshold: 5)
- Compaction: Yes/No
- Assessment: Healthy -- actively monitoring / Idle -- no actions taken in Xh / Stuck -- looping on errors
```

**Key:** The global monitor review should answer: "Is the deputy-CTO monitor actually doing useful work, or just burning tokens on sleep loops?" Look for concrete actions (bypass triage, signals, task creation) vs. pure polling. If the monitor has been running for hours with zero actions, note that it may be over-monitoring for the current workload.

---

## Step 5: Done

Output is complete. Do NOT loop, sleep, or repeat. Do NOT call `update_monitor_state` or `stop_monitoring`.

---

## Rules

**DO:**
- Call MCP tools directly in Step 2 for fast structural data
- Spawn exactly ONE investigator sub-agent in Step 3 for deep session analysis
- Construct the investigator prompt dynamically with actual session IDs, worktree paths, and persistent task IDs from Step 2
- Start with executive summary, drill down layer by layer
- Quote session messages verbatim with indices in the session deep dive
- Reference specific evidence (message indices, error text, PR numbers, file paths) throughout
- Page backward through session history when recent messages are uninteresting (sleep/polling)
- Show plan dashboard and blocking status for active plans
- Include recently completed tasks to show throughput
- End with a specific, evidence-based verdict
- Always include Section 9 (Global Monitor Review) as the final section -- even when the monitor is disabled/inactive, report its state

**DO NOT:**
- Loop, sleep, or repeat -- this is a one-shot command
- Call `update_monitor_state` or `stop_monitoring` -- no state management
- Use Bash to write or delete state files
- Write vague assessments like "system looks healthy" without evidence
- Skip the investigator step -- it's the most valuable part of the report
- Spawn more than one investigator -- one agent reviews all sessions
- Paraphrase session messages in the deep dive -- quote them verbatim
- Create tasks, modify files, or take any action -- this is read-only
