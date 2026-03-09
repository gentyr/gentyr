<!-- HOOK:GENTYR:demo -->

# /demo-bulk - Run All Demos Headless with Recording

Runs every demo scenario headlessly in batches with video recording enabled.
No interaction required. Smart defaults handle everything.

"Just run everything and tell me what passed."

## Instructions

### Step 1: Run Preflight

Call `mcp__playwright__preflight_check({ project: "demo" })`.

Show a brief summary of all checks.

### Step 2: Escalate Preflight Failures

If `ready: false`, report each specific failure and its suggested fix:

| Failed check | Suggested fix |
|---|---|
| `config_exists` | Create `playwright.config.ts` in project root. |
| `dependencies_installed` | Run `pnpm add -D @playwright/test`. |
| `browsers_installed` | Run `npx playwright install chromium`. |
| `test_files_exist` | Check `e2e/demo/` structure. Demo files must exist. |
| `credentials_valid` | Check 1Password vault mappings. |
| `compilation` | Fix TypeScript errors. Run `npx playwright test --list --project=demo`. |
| `dev_server` | Dev server auto-starts, but check for app-level errors if it fails. |
| `auth_state` | Call `mcp__playwright__run_auth_setup()`. |

STOP — do not proceed until preflight passes.

### Step 3: Launch Batch Run

Call `mcp__playwright__run_demo_batch({ project: "demo" })`.

All defaults are correct:
- `headless: true` — no browser window
- `record_video: true` — every scenario recorded
- `batch_size: 5` — balanced throughput
- `slow_mo: 0` — full speed

Report the batch_id and scenario count.

> **Note:** ADK demo files (`category: "adk"`) self-skip when `REPLAY_SESSION_ID` is not set.
> They will appear as "skipped" in results. Use `/replay` to run ADK demos.

### Step 4: Monitor Progress

Wait 15 seconds after launch, then call `mcp__playwright__check_demo_batch_result({ batch_id: "<ID>" })`.

Poll every 15 seconds. Between polls, show progress:
```
Batch Progress: 12/42 scenarios (10 passed, 2 failed) — batch 3/9
```

- If `status: "running"`: show progress and poll again.
- If `status: "passed"`: proceed to Step 5.
- If `status: "failed"`: proceed to Step 6.
- If `status: "stopped"`: report final state.

### Step 5: Report Success

```
Demo Batch Results
━━━━━━━━━━━━━━━━━
  Status:   PASSED
  Passed:   N
  Failed:   0
  Skipped:  N
  Duration: Xs
  Videos:   .claude/recordings/demos/
```

### Step 6: Report and Escalate Failures

```
Demo Batch Results
━━━━━━━━━━━━━━━━━
  Status:   FAILED
  Passed:   N
  Failed:   N
  Skipped:  N
  Duration: Xs

Failed Scenarios:
  - <scenario title>: <failure summary>
  - ...
```

Create a single **urgent DEPUTY-CTO task** via `mcp__cto-reports__report_to_cto` with:
- Count of failed scenarios and their failure summaries
- Video paths for failed scenarios (if available)
- Repair instruction: "Investigate demo batch failures. Assign to appropriate specialist."

## Rules

- **Zero questions** — smart defaults handle everything
- **Every failure goes to the deputy-CTO**
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
