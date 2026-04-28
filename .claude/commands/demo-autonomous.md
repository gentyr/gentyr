<!-- HOOK:GENTYR:demo -->

# /demo-autonomous - Launch Auto-Play Demo (Human-Watchable Speed)

Runs a chosen curated demo scenario at human-watchable speed (slowMo 800ms)
in a visible headed browser. No clicking required — the demo plays through
automatically with video recording. The browser closes when the demo completes.

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

### Step 2b: Filter by Consumption Mode (optional)

If the selected persona's scenarios have more than one distinct `category` value,
present via `AskUserQuestion` (single-select):
- **"All modes"** (Recommended) — Show every scenario
- **"[gui] Browser / UI"** — Playwright browser demos
- **"[sdk] SDK / LiveCodes"** — Code playground demos
- **"[api] API Management"** — Dashboard API demos
- **"[adk] AI Agent Replay"** — Replay recorded AI sessions

Only show mode options that exist in the persona's scenarios. If all scenarios share
one category, skip this step.

If a mode is selected, filter `scenarios[]` by matching `category` before Step 3.

### Step 3: Select Scenario

Get the scenarios array from the selected persona's group.

If only one scenario, use it directly (skip prompt).

Otherwise, present via `AskUserQuestion`:
- **question**: "Which scenario?"
- **options**: One per scenario. Label = `[{category}] {title}` with category padded to 5 chars for alignment (e.g., `[gui ] Onboarding Flow`). Description = first sentence of description.

### Step 4: Run Preflight

Call `mcp__playwright__preflight_check({ project: "<scenario.playwright_project>" })`.

### Step 5: Escalate Failures

If `ready: false`, create a single urgent DEPUTY-CTO task covering all failures
with per-check repair instructions (same table as `/demo-interactive`). STOP.

### Step 6: Launch

Call `mcp__playwright__run_demo({
  project: "<scenario.playwright_project>",
  test_file: "<scenario.test_file>",
  scenario_id: "<scenario.id>",
  slow_mo: 800,
  recorded: true,
  remote: false,
  success_pause_ms: 5000
})`.

Runs locally with video recording so the CTO can watch the demo live.

### Step 6b: ADK Replay Path

If the selected scenario has `category: "adk"`:

Instead of calling `run_demo` with the scenario's `test_file`, show:
> "ADK scenarios use session replay. Checking for past sessions..."

1. Call `mcp__user-feedback__list_feedback_runs({ limit: 5 })` and filter to the selected persona.
2. If sessions exist:
   - Call `mcp__user-feedback__get_session_audit({ session_id: "<most_recent_session_id>" })`.
   - If audit has actions, call `mcp__playwright__run_demo({
       project: "<scenario.playwright_project>",
       test_file: "e2e/demo/session-replay-runner.demo.ts",
       scenario_id: "<scenario.id>",
       slow_mo: 800,
       recorded: true,
       remote: false,
       success_pause_ms: 5000,
       extra_env: {
         REPLAY_SESSION_ID: "<session_id>",
         REPLAY_AUDIT_DATA: JSON.stringify(auditActions)
       }
     })`.
   - Continue to Step 7 with the returned PID.
3. If no sessions exist:
   > "No recorded sessions for this persona. Run this scenario via `/persona-feedback` first to generate a session that can be replayed."
   > STOP.

### Step 7: Report Launch

Show scenario title, persona, auth project, and PID.

### Step 8: Monitor Demo Completion

Wait 10 seconds, then call `mcp__playwright__check_demo_result({ pid: <PID> })`.

Poll every 10 seconds (max 30 polls, ~5 min total).

Between polls, show progress updates to the user:
```
Progress: 3/8 tests (3 passed, 0 failed) - Current: Login Flow
```

- If `status: "running"` and `progress.has_failures: true`: call `mcp__playwright__stop_demo({ pid: <PID> })` to kill remaining tests immediately, then create an **urgent DEPUTY-CTO task** with the failure details from the progress snapshot.
- If `status: "running"` and `progress.recent_errors` is non-empty: report errors to user immediately but continue polling (errors may be transient).
- If `status: "running"`: show progress and poll again.
- If `status: "failed"`: create an **urgent DEPUTY-CTO task** with:
  - Failure summary (`failure_summary` field)
  - Exit code
  - Screenshot paths (if any) — include as a bulleted list
  - The scenario title and test file for context
  - Repair instruction: "Investigate the demo test failure and fix the underlying issue"
- If `status: "passed"`: wait 5 seconds, then verify browser is still alive by checking PID. Report success with duration.
- If polls exhausted (`status` still `"running"`): the demo is still running (large scenario). Continue polling every 30 seconds until completion.

### Step 9: Tips

- The demo runs automatically at human-watchable speed — just watch
- Default pace is 800ms between actions
- Video is recorded to `.claude/recordings/demos/{scenarioId}.mp4` (macOS only, via window recorder)
- The browser closes when the demo completes
- To try another scenario, run `/demo-autonomous` again
- To interact with the app: `/demo-interactive`
- To browse all tests: `/demo`

## Rules

- **Every failure goes to the deputy-CTO** — no failure is unrecoverable
- **Never skip preflight**
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **Never launch when preflight fails** — always escalate first
