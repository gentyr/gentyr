<!-- HOOK:GENTYR:demo -->

# /demo-session - Interactive Demo Session with Recording

Pick specific demos to watch in a headed, recorded walkthrough. Choose by
persona, category, or individual scenarios.

"Show me the billing and webhook demos."

## Instructions

### Step 1: Run Preflight

Call `mcp__playwright__preflight_check({ project: "demo" })`.

Show a brief summary of all checks. STOP if preflight fails (same escalation
table as `/demo-bulk`).

### Step 2: Show Available Demos

Query `mcp__user-feedback__list_scenarios({ enabled_only: true })` to get the
full scenario list with persona names and categories.

Present the user with a selection using AskUserQuestion:

**Option A: "By persona"** — Pick persona(s), run all their scenarios.
**Option B: "By category"** — Pick gui/sdk/adk/api, run all matching.
**Option C: "Specific scenarios"** — Multi-select from the full list.
**Option D: "All demos"** — Run everything headed with recording.

### Step 3: Build Selection

Based on the user's choice, build the filter parameters:
- **By persona**: Use `persona_ids` parameter
- **By category**: Use `category_filter` parameter
- **Specific scenarios**: Use `scenario_ids` parameter
- **All demos**: No filter (runs all enabled scenarios)

### Step 4: Launch Session

Call `mcp__playwright__run_demo_batch({
  project: "demo",
  headless: false,
  slow_mo: 800,
  batch_size: <number of selected scenarios>,
  <filter params from Step 3>
})`.

Key differences from `/demo-bulk`:
- `headless: false` — browser window visible
- `slow_mo: 800` — watchable speed
- `batch_size` set to selection size — runs all selected in one batch for seamless viewing
- All demos are automatically recorded

Report the batch_id and scenario count.

### Step 5: Monitor Progress

Wait 15 seconds, then poll `mcp__playwright__check_demo_batch_result` every 15s.

Between polls, show progress:
```
Session: 3/8 scenarios (3 passed) — Current: Webhook Configuration
```

### Step 6: Report Results

Show results table:

```
Demo Session Results
━━━━━━━━━━━━━━━━━━━
  Status:   PASSED/FAILED
  Passed:   N
  Failed:   N
  Skipped:  N
  Duration: Xs

Per-Scenario:
  [PASS] Billing Overview (video: .claude/recordings/demos/<id>.mp4)
  [PASS] Webhook Config   (video: .claude/recordings/demos/<id>.mp4)
  [FAIL] API Dashboard    — <failure summary>
```

If any failures, create an urgent DEPUTY-CTO task with failure details.

## Natural Language Detection

When invoked via natural language instead of slash command (e.g., "show me the
billing and webhook demos"), the agent should:

1. Map the request to matching scenarios by title/persona/category
2. Skip the AskUserQuestion step
3. Proceed directly to Step 4 with the inferred selection

## Rules

- **All demos are automatically recorded** — video recording is always enabled
- **Every failure goes to the deputy-CTO**
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
