<!-- HOOK:GENTYR:show -->
# /show - Status Display Reference

View individual dashboard sections using `mcp__show__*` tools.

## Available Sections

| Tool | Description |
|---|---|
| `mcp__show__show_quota()` | API quota utilization (5-hour and 7-day usage bars) |
| `mcp__show__show_accounts()` | Account overview with key status, usage, and subscription info |
| `mcp__show__show_deputy_cto()` | Deputy-CTO triage pipeline (pending questions, rejections, reports) |
| `mcp__show__show_usage()` | Usage trends and trajectory projections (line graphs) |
| `mcp__show__show_automations()` | Running automated agents, token usage by type, and concurrency |
| `mcp__show__show_testing()` | Test health (pass/fail rates, coverage, Codecov integration) |
| `mcp__show__show_deployments()` | Recent deployments across Render and Vercel with pipeline status |
| `mcp__show__show_worktrees()` | Active git worktrees with branch, age, and PR status |
| `mcp__show__show_infra()` | Infrastructure status (Render, Vercel, Supabase, Elastic, Cloudflare) |
| `mcp__show__show_logging()` | Log volume, error rates, and top error messages from Elasticsearch |
| `mcp__show__show_timeline()` | Chronological timeline of recent system events |
| `mcp__show__show_tasks()` | Task metrics (pending, active, completed) and token usage summary |

## Usage

Call any tool directly. Pass `{ limit: N }` to expand the number of rows shown:

```
mcp__show__show_deployments()              // default rows
mcp__show__show_deployments({ limit: 20 }) // expanded view
mcp__show__show_timeline({ limit: 50 })    // more timeline events
```

## When to Use

- **Before deploying** — check `show_deployments` and `show_infra`
- **Before heavy work** — check `show_quota` and `show_usage`
- **Before writing tests** — check `show_testing`
- **Before spawning agents** — check `show_automations` and `show_tasks`
- **Before provisioning worktrees** — check `show_worktrees`

For the full dashboard, use `/cto-report` instead.
