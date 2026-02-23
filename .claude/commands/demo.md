<!-- HOOK:GENTYR:demo -->

# /demo - Launch Product Demo

Detects environment deficiencies and escalates ALL failures as urgent deputy-CTO tasks.
No failure is unrecoverable — agents can repair everything.

## Instructions

### Step 1: Display Readiness Summary

Show all prefetch data. Highlight any `criticalIssues` and auth staleness prominently. If `authState.isStale` is true, show a prominent warning that auth will need repair.

### Step 2: Ask User for Demo Project

Use `AskUserQuestion`:

| Option | Project | Description |
|--------|---------|-------------|
| Full product demo | `demo` | Dashboard + extension in single Chromium session |
| Dashboard only | `manual` | Vendor dashboard with `page.pause()` for inspection |
| Extension only | `extension-manual` | Browser extension scaffolds with `page.pause()` |
| Vendor Owner walkthrough | `vendor-owner` | Full dashboard access as Owner persona |

### Step 3: Run Preflight

Call `mcp__playwright__preflight_check({ project: "<selected>" })`.

This runs all checks including auth_state freshness.

### Step 4: Escalate ALL Failures as a Single Urgent Deputy-CTO Task

If `ready: false` (any failures at all):

1. Build a description covering every failed check. For each entry in `failures[]`, append specific repair instructions using this mapping:

| Failed check | Repair instruction for deputy-CTO |
|---|---|
| `config_exists` | Create `playwright.config.ts` in project root. Investigate existing test structure. Assign to CODE-REVIEWER section with urgent priority. |
| `dependencies_installed` | Run `pnpm add -D @playwright/test` via Bash. Verify `node_modules/@playwright/test` exists afterward. |
| `browsers_installed` | Run `npx playwright install chromium` via Bash. Verify Chromium appears in `~/Library/Caches/ms-playwright/`. |
| `test_files_exist` | Create test files for project `<project>`. Check `e2e/<dir>` structure. Assign to TEST-WRITER section with urgent priority. |
| `credentials_valid` | Check 1Password vault mappings for SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY. Assign to INVESTIGATOR & PLANNER with urgent priority if not resolvable directly. |
| `compilation` | Fix TypeScript errors. Run `npx playwright test --list --project=<project>` for details. Assign to CODE-REVIEWER section with urgent priority. |
| `auth_state` | Call `mcp__playwright__run_auth_setup()`. Verify `success: true` and all 4 `.auth/*.json` files refreshed. If fails, assign to INVESTIGATOR & PLANNER section with urgent priority. |

2. Call `mcp__todo-db__create_task` with:
   - `section`: `"DEPUTY-CTO"`
   - `priority`: `"urgent"`
   - `assigned_by`: `"demo"`
   - `title`: `"Repair Playwright environment — <N> preflight check(s) failed for project <project>"`
   - `description`: Full description covering all failures and per-check repair instructions (see template below)

Description template:
```
Preflight failed for project '<project>'.

Failed checks:
- <check_name>: <message>
(one line per failure)

Repair instructions:
<per-check instructions from table above, only for failed checks>

After all repairs, verify: mcp__playwright__preflight_check({ project: '<project>' }) returns ready: true.
Assign sub-tasks with priority: urgent as needed. Do NOT defer.
```

3. Show the user a clear summary:
   > "Found N issue(s): [list of failures]. Created urgent repair task #`<id>` for the deputy-CTO. A repair session will be dispatched within the next automation cycle (~10 min). Re-run `/demo` once repairs complete."

4. **STOP** — do not launch.

### Step 5: Launch

If preflight passes (`ready: true`), call `mcp__playwright__launch_ui_mode({ project: "<selected>" })`.

### Step 6: Report

Show project, PID, and tips:
- Tests appear in the left sidebar — click to run
- Filter bar searches test names

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable by an agent
- **Never skip preflight** — Playwright GUI can open but display zero tests (silent failure)
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
