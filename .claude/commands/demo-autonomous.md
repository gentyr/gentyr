<!-- HOOK:GENTYR:demo -->

# /demo-autonomous - Launch Auto-Play Demo (Human-Watchable Speed)

Runs a chosen curated demo scenario at human-watchable speed (slowMo 800ms)
in a visible headed browser. No clicking required — the demo plays through
automatically. The browser stays open after the scenario finishes so you can
inspect the final state.

"Show me the product in action."

## Instructions

### Step 1: Display Readiness Summary

Show all prefetch data briefly. Highlight any `criticalIssues` prominently.

### Step 2: Select Persona

If prefetch `personaGroups` is empty or missing, fall back to
`mcp__user-feedback__list_scenarios({ enabled_only: true })` and group by
`persona_name` into the same structure: `{ persona_name, playwright_project, scenarios[] }`.

If zero personas have scenarios:
> "No demo scenarios configured yet. The product-manager agent creates
> scenarios — run a product-manager evaluation first, or create scenarios
> manually via `mcp__user-feedback__create_scenario`."
>
> **Tip:** Use `/demo` to browse all tests in Playwright UI mode instead.
> STOP.

If only one persona has scenarios, use it directly (skip prompt).

Otherwise, present via `AskUserQuestion`:
- **question**: "Which persona?"
- **options**: One per persona from `personaGroups`. Label = `[N] <persona_display_name>` where N is that persona's scenario count (e.g., `[3] Vendor (Owner)`). Description = playwright project name.

### Step 3: Select Scenario

Get the scenarios array from the selected persona's group.

If only one scenario, use it directly (skip prompt).

Otherwise, present via `AskUserQuestion`:
- **question**: "Which scenario?"
- **options**: One per scenario. Label = scenario title. Description = first sentence of description + category in parentheses if set.

### Step 4: Run Preflight

Call `mcp__playwright__preflight_check({ project: "<scenario.playwright_project>" })`.

### Step 5: Escalate Failures

If `ready: false`, create a single urgent DEPUTY-CTO task covering all failures
with per-check repair instructions (same table as `/demo-interactive`). STOP.

### Step 6: Launch

Call `mcp__playwright__run_demo({
  project: "<scenario.playwright_project>",
  test_file: "<scenario.test_file>",
  slow_mo: 800,
  pause_at_end: true
})`.

### Step 7: Report Launch

Show scenario title, persona, auth project, and PID.

### Step 8: Monitor Demo Completion

Wait 30 seconds, then call `mcp__playwright__check_demo_result({ pid: <PID> })`.

- If `status: "running"`: wait another 30s and poll again (max 5 polls, ~2.5 min total).
- If `status: "failed"`: create an **urgent DEPUTY-CTO task** with:
  - Failure summary (`failure_summary` field)
  - Exit code
  - Screenshot paths (if any) — include as a bulleted list
  - The scenario title and test file for context
  - Repair instruction: "Investigate the demo test failure and fix the underlying issue"
- If `status: "passed"`: report success with duration.
- If polls exhausted (`status` still `"running"`): the autonomous flow completed successfully and the browser is paused at the final screen. Report success — if the test had failed, the process would have exited.

### Step 9: Tips

- The demo runs automatically at human-watchable speed — just watch
- Default pace is 800ms between actions
- The browser stays open after the scenario finishes — you can inspect the final state
- Close the browser manually when done, or just leave it
- To try another scenario, run `/demo-autonomous` again
- To interact after a demo: `/demo-interactive`
- To browse all tests: `/demo`

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
