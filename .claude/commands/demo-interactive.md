<!-- HOOK:GENTYR:demo -->

# /demo-interactive - Launch Demo Scenario (Full Speed + Pause)

Runs a chosen curated demo scenario at full Playwright speed, then pauses at
the end so you can manually interact with the app from that scaffolded state.

"Take me to this screen."

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
with per-check repair instructions:

| Failed check | Repair instruction for deputy-CTO |
|---|---|
| `config_exists` | Create `playwright.config.ts` in project root. Investigate existing test structure. Assign to CODE-REVIEWER section with urgent priority. |
| `dependencies_installed` | Run `pnpm add -D @playwright/test` via Bash. Verify `node_modules/@playwright/test` exists afterward. |
| `browsers_installed` | Run `npx playwright install chromium` via Bash. Verify Chromium appears in `~/Library/Caches/ms-playwright/`. |
| `test_files_exist` | Create test files for project `<project>`. Check `e2e/<dir>` structure. Assign to TEST-WRITER section with urgent priority. |
| `credentials_valid` | Check 1Password vault mappings. Assign to INVESTIGATOR & PLANNER with urgent priority if not resolvable directly. |
| `compilation` | Fix TypeScript errors. Run `npx playwright test --list --project=<project>` for details. Assign to CODE-REVIEWER section with urgent priority. |
| `auth_state` | Call `mcp__playwright__run_auth_setup()`. Verify `success: true` and all `.auth/*.json` files refreshed. If fails, assign to INVESTIGATOR & PLANNER section with urgent priority. |

STOP — do not launch.

### Step 6: Launch

Call `mcp__playwright__run_demo({
  project: "<scenario.playwright_project>",
  test_file: "<scenario.test_file>",
  slow_mo: 0,
  pause_at_end: true
})`.

### Step 7: Report

Show scenario title, persona, auth project, PID, and tips:
- The scenario runs at full speed then pauses for you to interact
- Close the browser window when done
- To try another scenario, run `/demo-interactive` again
- To browse all tests: `/demo`

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
