<!-- HOOK:GENTYR:cto-report -->
# /cto-report - CTO Status Dashboard

Generate a comprehensive CTO status dashboard using the Ink-based dashboard app.

The prefetch hook has pre-gathered key metrics (pending questions, task counts, triage stats, automation state) and injected them as a `[PREFETCH:cto-report]` systemMessage above. Use that data to supplement the dashboard output. For the full dashboard, always run the command below.

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

## Notes

- This is a **read-only report** - it does not modify any state
- For interactive decision-making, use `/deputy-cto` instead
- Timeline shows the 20 most recent events
- Quota shows aggregate across all active API keys (if key rotation is enabled)
