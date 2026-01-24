# /cto-report - CTO Status Dashboard

Generate a comprehensive CTO status dashboard using the Ink-based dashboard app.

## What to Do

The dashboard is installed in the GENTYR repo. Run this command to display it:

```bash
# Detect GENTYR installation path by following the symlink (3 levels up from .claude/commands/cto-report.md)
GENTYR_PATH=$(dirname $(dirname $(dirname $(readlink -f .claude/commands/cto-report.md 2>/dev/null || echo ".claude/commands/cto-report.md"))))
CLAUDE_PROJECT_DIR=$(pwd) node "$GENTYR_PATH/packages/cto-dashboard/dist/index.js"
```

This will render a terminal dashboard with:
- Rounded corner containers
- Quota bars with color-coded percentages
- System status (Deputy CTO, Protection, Commits)
- Chronological timeline of sessions, hooks, reports, questions, and tasks
- Metrics summary grid (Tokens, Sessions, Agents, Tasks, Hooks, Triage, CTO Queue, Cooldowns)

## Optional: Custom Time Range

For a different time period (default is 24 hours):

```bash
GENTYR_PATH=$(dirname $(dirname $(dirname $(readlink -f .claude/commands/cto-report.md 2>/dev/null || echo ".claude/commands/cto-report.md"))))
CLAUDE_PROJECT_DIR=$(pwd) node "$GENTYR_PATH/packages/cto-dashboard/dist/index.js" --hours 8
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
