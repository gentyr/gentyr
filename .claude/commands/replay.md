# /replay - Replay Past Feedback Sessions

Browse and replay recorded feedback sessions in a visible headed browser.
Fetches the audit trail from a completed feedback session, converts it to
RecordingActions, and launches `session-replay-runner.demo.ts` at 800ms
slowMo with thinking bubble overlays.

"Show me what the AI agent did."

## Instructions

### Step 1: Fetch Sessions

Call `mcp__user-feedback__list_feedback_runs({ limit: 20 })`.

If zero runs exist:
> "No feedback sessions recorded. Run `/persona-feedback` first to generate
> feedback sessions that can be replayed."
> STOP.

### Step 2: Filter by Mode (optional)

Present via `AskUserQuestion` (single-select):
- **"Show all sessions"** (Recommended) — Display every session regardless of mode
- **"Filter by mode"** — Narrow to a specific consumption mode
- **"Cancel"** — Exit

If "Cancel", STOP.

If "Filter by mode", present a second `AskUserQuestion` (single-select) with only
the modes that exist in the fetched sessions:
- `[gui] Browser / UI`
- `[sdk] SDK / LiveCodes`
- `[api] API Management`
- `[adk] AI Agent Replay`

Filter the session list to only matching `category` values.

### Step 3: Select Session

Present via `AskUserQuestion` (single-select):
- One option per session
- **label**: `[{category}] {scenario_title}` (or persona name if no scenario title)
- **description**: `{persona_name} — {date} | {action_count} actions`

If only one session exists after filtering, use it directly (skip prompt).

### Step 4: Run Preflight

Call `mcp__playwright__preflight_check({ project: "demo" })`.

Show a brief summary of all checks.

### Step 5: Escalate Preflight Failures

If `ready: false`, create a single urgent DEPUTY-CTO task covering all failures
with per-check repair instructions:

| Failed check | Repair |
|---|---|
| `config_exists` | CODE-REVIEWER: Create `playwright.config.ts` |
| `dependencies_installed` | Run `pnpm add -D @playwright/test` |
| `browsers_installed` | Run `npx playwright install chromium` |
| `credentials_valid` | INVESTIGATOR & PLANNER: Check 1Password vault |
| `auth_state` | Call `mcp__playwright__run_auth_setup()` |
| `dev_server` | Start dev server or verify webServer config |

STOP — do not proceed until preflight passes.

### Step 6: Fetch Audit Trail

Call `mcp__user-feedback__get_session_audit({ session_id: "<selected_session_id>" })`.

If zero actions returned:
> "Session has no recorded actions. The feedback agent may not have performed
> any observable actions during this session."
> STOP.

### Step 7: Launch Replay

Call `mcp__playwright__run_demo({
  project: "demo",
  test_file: "e2e/demo/session-replay-runner.demo.ts",
  slow_mo: 800,
  extra_env: {
    REPLAY_SESSION_ID: "<session_id>",
    REPLAY_AUDIT_DATA: JSON.stringify(auditActions)
  }
})`.

Report the PID returned.

### Step 8: Monitor Replay

Wait 10 seconds, then call `mcp__playwright__check_demo_result({ pid: <PID> })`.

Poll every 10 seconds (max 30 polls, ~5 min total).

Between polls, show progress updates:
```
Replay: 3/8 actions (3 passed, 0 failed) - Current: Navigate to Dashboard
```

- If `progress.has_failures: true`: call `mcp__playwright__stop_demo({ pid })`,
  then create an **urgent DEPUTY-CTO task** with failure details. STOP.
- If `status: "failed"`: create an **urgent DEPUTY-CTO task** with failure
  summary, exit code, and screenshot paths. STOP.
- If `status: "passed"`: report success with session, persona, mode, action
  count, and duration.
- If polls exhausted and still `"running"`: replay completed successfully
  (the browser is paused at the final screen). Report success.

### Step 9: Report

Show completion summary:

```
Replay Complete
━━━━━━━━━━━━━━━
  Session:  {session_id}
  Persona:  {persona_name}
  Mode:     {consumption_mode}
  Actions:  {action_count}
  Duration: {elapsed}s
  Status:   PASSED
```

## Rules

- **Never skip preflight** — always validate before launching
- **Never use CLI** — `npx playwright test` bypasses credential injection
- **All failures go to deputy-CTO** — no failure is unrecoverable
- **Never launch when preflight fails** — escalate first, then stop
- **Audit data is passed via extra_env** — `REPLAY_SESSION_ID` and `REPLAY_AUDIT_DATA` env vars
