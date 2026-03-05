<!-- HOOK:GENTYR:demo -->

# /demo-all - Run Full Demo Suite (Watchable Speed)

Runs every demo test in the full suite at human-watchable speed (slowMo 1200ms)
with cursor visualization enabled. No interaction required — all demos play
through automatically in sequence. Designed for a full product walkthrough or
pre-presentation confidence check.

"Show me everything working."

## Instructions

### Step 1: Run Preflight

Call `mcp__playwright__preflight_check({ project: "demo" })`.

Show a brief summary of all checks.

### Step 2: Escalate Preflight Failures

If `ready: false`, report each specific failure and its suggested fix:

| Failed check | Suggested fix |
|---|---|
| `config_exists` | Create `playwright.config.ts` in project root. Investigate existing test structure. |
| `dependencies_installed` | Run `pnpm add -D @playwright/test`. Verify `node_modules/@playwright/test` exists. |
| `browsers_installed` | Run `npx playwright install chromium`. Verify Chromium appears in `~/Library/Caches/ms-playwright/`. |
| `test_files_exist` | Check `e2e/demo/` structure. Demo files must exist before running. |
| `credentials_valid` | Check 1Password vault mappings. Credentials are required for auth. |
| `compilation` | Fix TypeScript errors. Run `npx playwright test --list --project=demo` for details. |
| `dev_server` | Start the dev server (e.g., `pnpm dev`) or verify `playwright.config.ts` webServer configuration. |
| `auth_state` | Call `mcp__playwright__run_auth_setup()`. Verify all `.auth/*.json` files are refreshed. |

STOP — do not proceed until preflight passes.

### Step 3: Launch All Demos

Call `mcp__playwright__run_demo({
  project: "demo",
  slow_mo: 1200,
  pause_at_end: false,
  show_cursor: true
})`.

No `test_file` filter — this runs the entire suite.

> **Note:** ADK demo files (`category: "adk"`) self-skip when `REPLAY_SESSION_ID` is not set.
> They will appear as "skipped" in the test results. Use `/replay` to run ADK demos.

Report the PID returned so the user can monitor the process externally if desired.

### Step 4: Monitor Progress

Wait 10 seconds after launch, then call `mcp__playwright__check_demo_result({ pid: <PID> })`.

Poll every 10 seconds. Maximum 60 polls (~10 minutes). If still running after 60 polls,
continue polling every 30 seconds until completion — the full suite takes longer than
a single scenario.

Between polls, show progress updates to the user:
```
Progress: 5/42 tests (5 passed, 0 failed) - Current: CTO Metrics Overview
```

- If `status: "running"` and `progress.has_failures: true`: call `mcp__playwright__stop_demo({ pid: <PID> })` to kill remaining tests immediately, then proceed to Step 6 (failure path).
- If `status: "running"` and `progress.recent_errors` is non-empty: report errors to user immediately but continue polling (errors may be transient).
- If `status: "running"`: show progress and poll again.
- If `status: "passed"`: proceed to Step 5 (success path).
- If `status: "failed"`: proceed to Step 6 (failure path).

### Step 5: Report Success

When all tests pass, show:

```
Demo Suite Results
━━━━━━━━━━━━━━━━━
  Status:   PASSED
  Passed:   N
  Failed:   0
  Skipped:  N
  Duration: Xs
```

No escalation needed. Inform the user the full suite is green.

### Step 6: Report and Escalate Failures

When any test fails, show results first:

```
Demo Suite Results
━━━━━━━━━━━━━━━━━
  Status:   FAILED
  Passed:   N
  Failed:   N
  Skipped:  N
  Duration: Xs

Failed Tests:
  - <test name>: <failure summary>
  - ...
```

Then create a single **urgent DEPUTY-CTO task** via `mcp__cto-reports__report_to_cto` with:

- The count of failed tests
- Each failed test name and its failure summary
- Screenshot paths if included in the result
- Repair instruction: "Investigate demo test failures from /demo-all run and fix the underlying issues. Assign failing tests to the appropriate specialist: UI bugs → CODE-WRITER, test logic → TEST-WRITER, flaky infra → INVESTIGATOR & PLANNER."

## Key Differences from Other Demo Commands

| Command | Mode | slowMo | Cursor | Scope |
|---|---|---|---|---|
| `/demo` | Interactive UI | n/a | n/a | Browse all tests |
| `/demo-autonomous` | Headed auto-play | 800ms | Off | Single scenario |
| `/demo-all` | Headed auto-play | 1200ms | On | Full suite |
| `/demo-validate` | Headless | n/a | n/a | Full suite |

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight**
- **Never proceed if preflight fails** — report specific failures and suggested fixes, then stop
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never filter by test file** — this command runs the entire suite
