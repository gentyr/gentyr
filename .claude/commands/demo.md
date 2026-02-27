<!-- HOOK:GENTYR:demo -->

# /demo - Browse All Tests (Playwright UI Mode)

Launches Playwright in interactive UI mode showing the full test suite.
Click to run individual tests. This is the developer escape hatch for
full access to all tests — not limited to curated demo scenarios.

For curated demo scenarios, use `/demo-interactive` or `/demo-autonomous`.

## Instructions

### Step 1: Display Readiness Summary

Show all prefetch data briefly. Highlight any `criticalIssues` prominently.

### Step 2: Select Persona

If prefetch `personaGroups` has entries, present persona selection:

If only one persona, use it directly (skip prompt).

Otherwise, present via `AskUserQuestion`:
- **question**: "Which persona?"
- **options**: One per persona from `personaGroups`. Label = `[N] <persona_display_name>` where N is that persona's scenario count (e.g., `[3] Vendor (Owner)`). Description = playwright project name. Also include an **"All tests"** option with description = "Browse the full test suite (all projects)" — this maps to no project filter.

If `personaGroups` is empty or missing, fall back to the existing behavior:
present `discoveredProjects` (excluding infrastructure: `setup`, `seed`, `auth-setup`, `cleanup`) as options via `AskUserQuestion`. If only one eligible project, use it directly.

After selection:
- If "All tests" chosen: launch UI mode with no project filter
- Otherwise: use the selected persona's `playwright_project`

### Step 3: Run Preflight

Call `mcp__playwright__preflight_check({ project: "<selected>" })`.

Skip preflight if "All tests" was chosen (no single project to check).

### Step 4: Escalate Failures

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

### Step 5: Launch

Call `mcp__playwright__launch_ui_mode({ project: "<selected>" })`.

If "All tests" was chosen, call `mcp__playwright__launch_ui_mode({})` with no project filter.

### Step 6: Report

Show project (or "All"), PID, and tips:
- Playwright UI mode is open — click tests to run them
- All tests are visible (spec, manual, demo)
- Close the Playwright window when done
- For curated demos: `/demo-interactive` (pause) or `/demo-autonomous` (watch)

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight** (except "All tests" mode)
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
