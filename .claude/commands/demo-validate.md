<!-- HOOK:GENTYR:demo -->

# /demo-validate - Validate All Demo Tests (Headless Gate)

Runs ALL demo tests and specs headlessly as a validation gate. Use this before
presentations, deployments, or after significant code changes to confirm the full
demo suite is passing.

"Are all the demos working?"

## Instructions

### Step 1: Run Preflight

Call `mcp__playwright__preflight_check({ project: "demo" })`.

Show a brief summary of all checks.

### Step 2: Escalate Preflight Failures

If `ready: false`, create a single urgent DEPUTY-CTO task covering all failures
with per-check repair instructions:

| Failed check | Repair instruction for deputy-CTO |
|---|---|
| `config_exists` | Create `playwright.config.ts` in project root. Investigate existing test structure. Assign to CODE-REVIEWER section with urgent priority. |
| `dependencies_installed` | Run `pnpm add -D @playwright/test` via Bash. Verify `node_modules/@playwright/test` exists afterward. |
| `browsers_installed` | Run `npx playwright install chromium` via Bash. Verify Chromium appears in `~/Library/Caches/ms-playwright/`. |
| `test_files_exist` | Create test files for project `demo`. Check `e2e/demo` structure. Assign to TEST-WRITER section with urgent priority. |
| `credentials_valid` | Check 1Password vault mappings. Assign to INVESTIGATOR & PLANNER with urgent priority if not resolvable directly. |
| `compilation` | Fix TypeScript errors. Run `npx playwright test --list --project=demo` for details. Assign to CODE-REVIEWER section with urgent priority. |
| `auth_state` | Call `mcp__playwright__run_auth_setup()`. Verify `success: true` and all `.auth/*.json` files refreshed. If fails, assign to INVESTIGATOR & PLANNER section with urgent priority. |

STOP — do not run tests.

### Step 3: Run All Demo Tests

Call `mcp__playwright__run_tests({ project: "demo", workers: 4, retries: 1 })`.

This runs all `.demo.ts`, `.spec.ts`, and `.manual.ts` files in the demo suite headlessly.

### Step 4: Report Results

When the run completes, report:

- Total tests: passed / failed / skipped
- Duration
- Any failed test names and their failure summaries

Format the report clearly:

```
Demo Validation Results
━━━━━━━━━━━━━━━━━━━━━━
  Passed:  N
  Failed:  N
  Skipped: N
  Duration: Xs

[If failures:]
Failed Tests:
  - <test name>: <failure summary>
  - ...
```

### Step 5: Escalate Failures

If any tests failed, create a single **urgent DEPUTY-CTO task** with:

- The count of failed tests
- Each failed test name and its failure summary
- Repair instruction: "Investigate demo test failures and fix the underlying issues. Assign failing tests to the appropriate specialist: UI bugs → CODE-WRITER, test logic → TEST-WRITER, flaky infra → INVESTIGATOR & PLANNER."

If all tests passed, report success. No DEPUTY-CTO task needed.

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
