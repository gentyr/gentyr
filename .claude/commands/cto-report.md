<!-- HOOK:GENTYR:cto-report -->
# /cto-report - CTO Status Dashboard

Generate a comprehensive CTO status dashboard using the Ink-based dashboard app.

The prefetch hook has pre-gathered key metrics (pending questions, task counts, triage stats, automation state) and injected them as `[PREFETCH:cto-report]` context above. Use that data to supplement the dashboard output. For the full dashboard, always run the command below.

## What to Do

Resolve the framework path (supports npm link, legacy symlink, and running from within the gentyr repo), then run the dashboard in three pages to avoid output truncation. Run these three Bash commands **sequentially**:

**Page 1 — Intelligence** (Header, Quota, Status, Accounts, Deputy-CTO, Usage, Automations):

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })" && node "$GENTYR_DIR/packages/cto-dashboard/dist/index.js" --page 1
```

**Page 2 — Operations** (Testing, Deployments, Worktrees, Infra, Logging):

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })" && node "$GENTYR_DIR/packages/cto-dashboard/dist/index.js" --page 2
```

**Page 3 — Analytics** (Feedback, PM, Worklog, Timeline, Metrics Summary):

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })" && node "$GENTYR_DIR/packages/cto-dashboard/dist/index.js" --page 3
```

## Optional: Custom Time Range

For a different time period (default is 24 hours, valid range: 1-168), add `--hours N` to each page command:

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })" && node "$GENTYR_DIR/packages/cto-dashboard/dist/index.js" --page 1 --hours 8
```

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })" && node "$GENTYR_DIR/packages/cto-dashboard/dist/index.js" --page 2 --hours 8
```

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })" && node "$GENTYR_DIR/packages/cto-dashboard/dist/index.js" --page 3 --hours 8
```

## Response Format

After running the dashboard command, respond with a **single short sentence** (e.g., "Dashboard rendered above — 66% quota used, 170 pending code-review tasks."). Do NOT write a multi-section summary with headers, bullet lists, or tables — that creates a second collapsible block in the UI and steals ctrl+o focus from the actual dashboard output.

## Notes

- This is a **read-only report** - it does not modify any state
- For interactive decision-making, use `/deputy-cto` instead
- Timeline shows the 20 most recent events
- Quota shows aggregate across all active API keys (if key rotation is enabled)
- **IMPORTANT**: Do NOT use the Read tool after running the dashboard command. The Bash output contains everything needed. Using Read creates a second collapsed item in the UI that conflicts with ctrl+o expansion of the dashboard output.
