<!-- HOOK:GENTYR:cto-report -->
# /cto-report - CTO Status Dashboard

Generate a comprehensive CTO status dashboard using the Ink-based dashboard app.

The prefetch hook has pre-gathered key metrics (pending questions, task counts, triage stats, automation state) and injected them as a `[PREFETCH:cto-report]` systemMessage above. Use that data to supplement the dashboard output. For the full dashboard, always run the command below.

## What to Do

Run the dashboard via the `.claude-framework` symlink (installed by setup):

```bash
node .claude-framework/packages/cto-dashboard/dist/index.js
```

This will render a terminal dashboard with quota bars, system status, deputy CTO triage pipeline, testing health, chronological timeline, and metrics summary.

## Optional: Custom Time Range

For a different time period (default is 24 hours, valid range: 1-168):

```bash
node .claude-framework/packages/cto-dashboard/dist/index.js --hours 8
```

## Notes

- This is a **read-only report** - it does not modify any state
- For interactive decision-making, use `/deputy-cto` instead
- Timeline shows the 20 most recent events
- Quota shows aggregate across all active API keys (if key rotation is enabled)
