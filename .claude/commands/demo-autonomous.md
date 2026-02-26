<!-- HOOK:GENTYR:demo -->

# /demo-autonomous - Launch Auto-Play Demo (Human-Watchable Speed)

Runs a chosen curated demo scenario at human-watchable speed (slowMo 800ms)
in a visible headed browser. No clicking required — the demo plays through
automatically. No pause at the end.

"Show me the product in action."

## Instructions

### Step 1: Display Readiness Summary

Show all prefetch data briefly. Highlight any `criticalIssues` prominently.

### Step 2: List Available Scenarios

If prefetch data includes `scenarios`, use that. Otherwise call
`mcp__user-feedback__list_scenarios({ enabled_only: true })`.

If zero scenarios exist:
> "No demo scenarios configured yet. The product-manager agent creates
> scenarios — run a product-manager evaluation first, or create scenarios
> manually via `mcp__user-feedback__create_scenario`."
>
> **Tip:** Use `/demo` to browse all tests in Playwright UI mode instead.
> STOP.

### Step 3: Select Scenario

Group scenarios by persona name (and category if set). For each, show:
- **Title** — the scenario name
- **Description** — first sentence only (truncate for readability)
- **Auth context** — the Playwright project (e.g., "as vendor-owner")

If only one scenario exists, use it directly.
If multiple, present via `AskUserQuestion`.

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
  pause_at_end: false
})`.

### Step 7: Report

Show scenario title, persona, auth project, PID, and tips:
- The demo runs automatically at human-watchable speed — just watch
- Default pace is 800ms between actions
- The browser closes when the scenario finishes
- To try another scenario, run `/demo-autonomous` again
- To interact after a demo: `/demo-interactive`
- To browse all tests: `/demo`

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
