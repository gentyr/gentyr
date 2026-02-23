<!-- HOOK:GENTYR:persona-feedback -->
# /persona-feedback - View Persona Feedback History & Spawn Sessions

Interactive command to **browse persona feedback history** and optionally **spawn a live feedback session** for any persona on demand.

The prefetch hook has pre-gathered persona list, recent feedback runs, and per-persona stats -- all injected as `[PREFETCH:persona-feedback]` context above. Use that data throughout this flow instead of calling list MCP tools. If the prefetch data is missing, call the MCP tools directly as fallback.

## Available Tools

- `mcp__feedback-explorer__get_feedback_overview` - System-wide feedback stats
- `mcp__feedback-explorer__get_persona_details` - Full persona profile, sessions, satisfaction
- `mcp__feedback-explorer__list_persona_reports` - CTO reports filed by a persona
- `mcp__feedback-explorer__list_persona_sessions` - Session history for a persona
- `mcp__feedback-explorer__get_session_details` - Drill into a specific session
- `mcp__user-feedback__start_feedback_run` - Spawn a live feedback session
- `mcp__user-feedback__list_personas` - List all personas (fallback if prefetch missing)

---

## Step 1: Display Overview

From the prefetch data, display a summary:

```
Persona Feedback Overview
-------------------------
Personas:     {enabled_count} enabled ({total_count} total)
Feedback Runs: {recent_run_count} recent (last 5)
Total Sessions: {total_sessions}
Total Findings: {total_findings}
```

If there are recent runs, show them briefly:

```
Recent Runs:
  {run_id} — {trigger_type} — {status} — {timestamp}
  ...
```

If there are **0 enabled personas**, inform the user: "No personas configured. Run `/configure-personas` to set up personas first." and stop.

## Step 2: Pick a Persona

Use `AskUserQuestion` (single-select) to let the user pick a persona.

Build options from the prefetch persona list. Each option:
- **label**: persona name
- **description**: `{consumption_mode} | Last session: {last_session_date or "never"} | Satisfaction: {satisfaction or "N/A"}`

Include a **"Cancel"** option:
- **label**: "Cancel"
- **description**: "Exit without action"

If the user selects "Cancel", stop.

## Step 3: Show Persona Feedback Overview

After selection, call:
- `mcp__feedback-explorer__get_persona_details({ persona_id: <selected_id> })` - Full profile, mapped features, recent sessions, satisfaction history
- `mcp__feedback-explorer__list_persona_reports({ persona_name: <selected_name>, limit: 10 })` - CTO reports from this persona

Render a summary:

```
{persona_name} ({consumption_mode})
------------------------------------
Description: {description}
Traits: {traits}
Endpoint: {endpoint}
Mapped Features: {feature_list}

Satisfaction Trend: {satisfaction_history or "No data yet"}
Sessions: {session_count} total | Last: {last_session_date}
Findings: {finding_count} total

Recent CTO Reports:
  [{priority}] {title} — {created_at}
  ...
  (or "No reports filed yet")
```

## Step 4: Action Menu

Use `AskUserQuestion` (single-select):

- **"Spawn feedback session"** (Recommended)
  - Description: "Run this persona now against its endpoints in the background"
- **"View session details"**
  - Description: "Drill into a specific past session for full findings"
- **"Done"**
  - Description: "Exit"

## Step 5a: If "Spawn feedback session"

Call:
```
mcp__user-feedback__start_feedback_run({
  trigger_type: "manual",
  persona_ids: [<selected_id>],
  max_concurrent: 1
})
```

Display confirmation:

```
Feedback session spawned!
  Run ID: {run_id}
  Persona: {persona_name}
  Status: running (background)

The session runs asynchronously. Findings will appear in the CTO triage pipeline.
Check progress with: /persona-feedback (select the same persona)
```

Stop after confirmation.

## Step 5b: If "View session details"

If the persona has past sessions (from Step 3 data), use `AskUserQuestion` to pick a session:
- Options from recent sessions: label = session date, description = status + finding count

Then call `mcp__feedback-explorer__get_session_details({ session_id: <selected> })` and display the full session report.

After showing details, return to Step 4 (action menu) so the user can take another action or exit.

If the persona has **no past sessions**, inform the user and return to Step 4.

## Step 5c: If "Done"

Stop.

---

## Communication Style

- Be concise — show data in structured format, not prose
- Use the prefetch data first, fall back to MCP tools only if prefetch is missing
- After spawning a session, clearly state it runs in the background (fire-and-forget)
- If a persona has no sessions or reports, say so briefly rather than showing empty tables
