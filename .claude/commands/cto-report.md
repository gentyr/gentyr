<!-- HOOK:GENTYR:cto-report -->
# /cto-report - CTO Status Dashboard

Generate a comprehensive CTO status dashboard using the Ink-based dashboard app.

The prefetch hook has pre-gathered key metrics (pending questions, task counts, triage stats, automation state) and injected them as `[PREFETCH:cto-report]` context above. Use that data to supplement the dashboard output. For the full dashboard, always run the command below.

## What to Do

Run the dashboard via the `node_modules/gentyr` package (installed by npm):

```bash
node node_modules/gentyr/packages/cto-dashboard/dist/index.js
```

This will render a terminal dashboard with quota bars, system status, deputy CTO triage pipeline, testing health, chronological timeline, and metrics summary.

## Optional: Custom Time Range

For a different time period (default is 24 hours, valid range: 1-168):

```bash
node node_modules/gentyr/packages/cto-dashboard/dist/index.js --hours 8
```

## Response Format

After running the dashboard command, respond with a **single short sentence** (e.g., "Dashboard rendered above — 66% quota used, 170 pending code-review tasks."). Do NOT write a multi-section summary with headers, bullet lists, or tables — that creates a second collapsible block in the UI and steals ctrl+o focus from the actual dashboard output.

## Notes

- This is a **read-only report** - it does not modify any state
- For interactive decision-making, use `/deputy-cto` instead
- Timeline shows the 20 most recent events
- Quota shows aggregate across all active API keys (if key rotation is enabled)
- **IMPORTANT**: Do NOT use the Read tool after running the dashboard command. The Bash output contains everything needed. Using Read creates a second collapsed item in the UI that conflicts with ctrl+o expansion of the dashboard output.
