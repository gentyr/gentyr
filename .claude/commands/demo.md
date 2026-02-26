<!-- HOOK:GENTYR:demo -->

# /demo - Browse All Tests (Playwright UI Mode)

Launches Playwright in interactive UI mode showing the full test suite.
Click to run individual tests. This is the developer escape hatch for
full access to all tests — not limited to curated demo scenarios.

For curated demo scenarios, use `/demo-interactive` or `/demo-autonomous`.

## Instructions

### Step 1: Display Readiness Summary

Show all prefetch data briefly. Highlight any `criticalIssues` prominently.

### Step 2: Discover and Select Project

1. If prefetch data includes `discoveredProjects`, use that
2. Otherwise read the project's `playwright.config.ts` via the Read tool
3. Exclude infrastructure projects (`setup`, `seed`, `auth-setup`, `cleanup`)
4. If only one eligible project remains, use it directly
5. If multiple, present via `AskUserQuestion`

### Step 3: Run Preflight

Call `mcp__playwright__preflight_check({ project: "<selected>" })`.

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

### Step 6: Report

Show project, PID, and tips:
- Playwright UI mode is open — click tests to run them
- All tests are visible (spec, manual, demo)
- Close the Playwright window when done
- For curated demos: `/demo-interactive` (pause) or `/demo-autonomous` (watch)

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
