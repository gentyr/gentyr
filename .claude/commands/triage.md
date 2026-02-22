<!-- HOOK:GENTYR:triage -->
# /triage - Force-Triage Pending Agent Reports

On-demand command to **immediately triage all pending agent reports**, bypassing the hourly automation's triage check interval and cooldowns.

The prefetch hook has pre-gathered pending report counts and running agent info, injected as `[PREFETCH:triage]` context above. Use that data for Step 1.

## Step 1: Display Current State

From the prefetch data, display a summary:

| Status | Count |
|--------|-------|
| Pending Reports | N |
| In-Progress | N |
| Self-Handled (total) | N |
| Escalated (total) | N |
| Dismissed (total) | N |

Also show: **Running agents**: N / M (N running, M max concurrent, K available slots)

If there are **0 pending reports**, inform the user and stop — nothing to triage.

## Step 2: Ask User

Use AskUserQuestion with **one question**:

**Question 1** — Action (multiSelect: false):
- **"Triage now"** — Spawn deputy-CTO to triage all pending reports (Recommended)
- **"Cancel"** — Do nothing

## Step 3: Spawn via MCP Tool

If the user chose "Cancel", stop.

Call a single MCP tool:

```
mcp__agent-tracker__force_triage_reports()
```

## Step 4: Display Results

From the tool response, display:

- **Agent ID**: the agentId
- **PID**: the process ID
- **Session ID**: the session UUID (for `claude --resume <session-id>`)
- **Pending Reports**: count of reports queued for triage

If a session ID was returned, display:

```
Resume into triage session:
  claude --resume <session-id>
```

## What This Bypasses

- Triage check interval (5-minute cooldown)
- Automation enabled flag (`autonomous-mode.json`)
- CTO activity gate (24h briefing requirement)

## What This Preserves

- Concurrency guard (checks running agents before spawning)
- Agent tracker registration (spawned agent appears in `/cto-report`)
- Per-item triage cooldown (via `get_reports_for_triage` filtering)
- Full triage decision framework (self-handle / escalate / dismiss)
