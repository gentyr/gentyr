# /cto-report - CTO Status Dashboard

Generate a comprehensive CTO status dashboard using the Ink-based dashboard app.

## What to Do

The dashboard is installed in the GENTYR repo. Run this command to display it:

```bash
# Find project root (walk up until we find .claude/commands), then resolve symlink to GENTYR
PROJECT_ROOT=$(d=$(pwd); while [ "$d" != "/" ] && [ ! -f "$d/.claude/commands/cto-report.md" ]; do d=$(dirname "$d"); done; echo "$d")
GENTYR_PATH=$(dirname $(dirname $(dirname $(readlink -f "$PROJECT_ROOT/.claude/commands/cto-report.md" 2>/dev/null || echo "$PROJECT_ROOT"))))
CLAUDE_PROJECT_DIR="$PROJECT_ROOT" node "$GENTYR_PATH/packages/cto-dashboard/dist/index.js"
```

This will render a terminal dashboard with:
- Rounded corner containers
- Quota bars with color-coded percentages
- System status (Deputy CTO, Protection, Commits)
- Deputy CTO triage pipeline (untriaged reports, escalated items, pending questions, 24h summary)
- Testing health (failing suites with fix attempts, agent breakdown by framework, resolved suites, unique failures, 7-day activity, optional Codecov)
- Chronological timeline of sessions, hooks, reports, questions, and tasks
- Metrics summary grid (Tokens, Sessions, Agents, Tasks, Hooks, Triage, CTO Queue, Cooldowns)

## Optional: Custom Time Range

For a different time period (default is 24 hours):

```bash
PROJECT_ROOT=$(d=$(pwd); while [ "$d" != "/" ] && [ ! -f "$d/.claude/commands/cto-report.md" ]; do d=$(dirname "$d"); done; echo "$d")
GENTYR_PATH=$(dirname $(dirname $(dirname $(readlink -f "$PROJECT_ROOT/.claude/commands/cto-report.md" 2>/dev/null || echo "$PROJECT_ROOT"))))
CLAUDE_PROJECT_DIR="$PROJECT_ROOT" node "$GENTYR_PATH/packages/cto-dashboard/dist/index.js" --hours 8
```

Valid range: 1-168 hours.

## Dashboard Layout

```
╭─────────────────────────────────────────────────────────────────────────────╮
│                          GENTYR CTO DASHBOARD                                │
│  Generated: 2026-01-23 16:45                             Period: Last 24h   │
╰─────────────────────────────────────────────────────────────────────────────╯

╭─ QUOTA & CAPACITY ──────────────╮  ╭─ SYSTEM STATUS ─────────────────────╮
│  5-hour  ████████░░ 78%          │  │  Deputy CTO: ENABLED  (in 15m)       │
│  7-day   ██████░░░░ 62%          │  │  Protection: PROTECTED               │
╰──────────────────────────────────╯  ╰──────────────────────────────────────╯

╭─ TIMELINE (24h) ────────────────────────────────────────────────────────────╮
│  16:42  ● HOOK  pre-commit-review                                           │
│         └─ deputy-cto-review: "Review commit abc123"                        │
│  16:30  ◆ REPORT  Security concern [HIGH]                                   │
│         └─ From: code-reviewer | Status: escalated                          │
│  16:15  ○ SESSION  User session (manual)                                    │
│  15:45  ● HOOK  todo-maintenance                                            │
╰──────────────────────────────────────────────────────────────────────────────╯

╭─ METRICS SUMMARY ───────────────────────────────────────────────────────────╮
│  ╭─ Tokens ──────╮  ╭─ Sessions ──╮  ╭─ Agents ───╮  ╭─ Tasks ─────╮        │
│  │ In:    2.4M   │  │ Task:   12  │  │ Spawns: 8  │  │ Pending:  3 │        │
│  │ Out:   456K   │  │ User:    4  │  │ Types:  5  │  │ Active:   1 │        │
│  │ Cache: 89%    │  │ Total:  16  │  │            │  │ Done:     7 │        │
│  ╰───────────────╯  ╰─────────────╯  ╰────────────╯  ╰─────────────╯        │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Dashboard Sections

### Deputy CTO Section
Shows the triage pipeline status:
- **Untriaged reports**: Agent reports pending CTO review
- **Escalated reports**: High-priority items requiring immediate attention
- **Pending questions**: CTO questions awaiting answers (blocks commits)
- **Recently triaged**: 24h summary of handled/dismissed reports

### Testing Section
Shows test health metrics derived from test-failure-state.json and agent-tracker:
- **Failing suites**: Name, age (color-coded: white <1h, yellow 1-6h, red >6h), framework (jest/vitest/playwright), fix attempt pips (●●●○○)
- **Agent breakdown (24h)**: Per-framework agent counts (jest, vitest, playwright, test-writer)
- **Resolved suites**: Suites targeted by agents in 24h but no longer failing
- **Unique failures**: Distinct failure hashes across all test-failure-state files (including workspace-level)
- **7-day activity**: Sparkline of test failure agent spawns
- **Codecov (optional)**: Current coverage % and 7-day trend sparkline (requires CODECOV_TOKEN, CODECOV_OWNER, CODECOV_REPO env vars)

### Timeline
Chronological view of the last 20 events across all data sources.

### Metrics Summary
Grid of metric boxes showing token usage, sessions, agents, tasks, hooks, triage, CTO queue, and cooldowns.

## Timeline Event Icons

| Icon | Type | Source |
|------|------|--------|
| ● | HOOK | agent-tracker (hook spawns) |
| ◆ | REPORT | cto-reports.db |
| ◇ | QUESTION | deputy-cto.db |
| ■ | TASK | todo.db (completed tasks) |
| ○ | SESSION | Session JSONL files |

## Notes

- This is a **read-only report** - it does not modify any state
- For interactive decision-making, use `/deputy-cto` instead
- Timeline shows the 20 most recent events
- Quota shows aggregate across all active API keys (if key rotation is enabled)
