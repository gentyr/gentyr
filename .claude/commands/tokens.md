<!-- HOOK:GENTYR:tokens -->
# /tokens — Token Usage Report

Renders per-source Claude token consumption from `.claude/state/token-usage.db` (populated by the `token-usage-collector` daemon).

## Arguments

`/tokens [range] [by <dimension>] [filter <key>=<value>] [top|health]`

| Argument | Values | Default |
|----------|--------|---------|
| range | `1h` / `24h` / `7d` / `30d` / `all` | `24h` |
| by    | `source` / `lane` / `agent_type` / `model` / `category` / `day` / `persistent_task` / `plan` | `source` |
| filter | `source=…` `model=…` `lane=…` `persistent_task=N` `plan=…` | none |
| top    | switches to top-sessions mode (returns hottest sessions) | off |
| health | switches to attribution health diagnostic | off |

Examples:
- `/tokens` — last 24h, grouped by source
- `/tokens 7d` — last 7 days, grouped by source
- `/tokens 24h by lane` — group by `persistent` / `audit` / `gate` / `automated` / `standard` / `subprocess` / `subagent` / `interactive`
- `/tokens 7d by agent_type`
- `/tokens 30d by persistent_task`
- `/tokens 1h by model` — Opus vs Sonnet vs Haiku split
- `/tokens 24h filter source=hourly-automation` — granular breakdown of a single source
- `/tokens 24h top` — top 20 most expensive sessions
- `/tokens health` — attribution coverage diagnostic

## Workflow (for the assistant)

1. Parse the arguments. Defaults: `range='24h'`, `group_by='source'`, `limit=50`.
2. **Health mode**: call `mcp__agent-tracker__token_attribution_health()`. Render: total session attributions, resolved/pending/unknown counts, oldest pending age in minutes, untagged subprocess count. Stop.
3. **Top mode**: call `mcp__agent-tracker__top_token_sessions({ range, limit: 20 })`. Render a table: `session_id` (first 8 chars), `source`, `agent_type`, `total_tokens` (human-readable: `K`/`M`), `cost_usd` (`$0.00` / `$0.0023` / `$12.35`), `duration_minutes`. Stop.
4. **Default mode**: call `mcp__agent-tracker__query_token_usage({ range, group_by, limit: 50, ...filters })` where `filter_source` / `filter_model` / `filter_lane` / `filter_persistent_task_id` / `filter_plan_id` are passed through when the user supplied them. The MCP tool returns:
   ```ts
   {
     range: { start_ms, end_ms, range_key },
     total: { tokens, cost_usd, sessions, messages },
     rows: [{ group_value, sessions, messages, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, pct_of_total, top_model }],
     group_by
   }
   ```
5. Render a one-line header summarising the range and totals (e.g. `Last 24h — grouped by source — total: 47.3M tok / $284.12 / 192 sessions`).
6. Render a sortable table with one row per group, ordered by `total_tokens` desc. Columns: `group_value`, `sessions`, `tokens` (human), `cost`, `% of total`, `top_model`. Use `formatTokens()`/`formatCost()` helpers documented below.
7. Render a horizontal bar chart **directly underneath** the table comparing the top 10 rows by `total_tokens`. Compute bar width `= round(row.total_tokens / max.total_tokens * 40)` (40 char wide). Use Unicode block `█` for filled and `░` (light shade) for empty. Add the percentage at the end of each bar.
   ```
   source                                          tokens     cost      bar                                          %
   hourly-automation:task_runner                  18.2M     $94.40    ████████████████████████████████████████  100%
   interactive-cto                                11.7M     $82.10    █████████████████████████░░░░░░░░░░░░░░░   64%
   persistent-task-spawner                         6.4M     $41.20    ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░   35%
   subprocess:live-feed-daemon                     2.1M      $1.68    █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   12%
   demo-failure-spawner                            1.8M     $11.40    ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   10%
   ```
8. If `rows.length === 0`, render a short message: "No token usage recorded in this range. If the collector daemon was just installed, wait ~1 minute for the first scan cycle."

## Formatters

- `formatTokens(n)`: returns `${n}` if `< 1000`, `${(n/1000).toFixed(1)}K` if `< 1_000_000`, `${(n/1_000_000).toFixed(1)}M` otherwise.
- `formatCost(usd)`: `$0.00` when `usd === 0`; `$<2 decimals>` when `usd >= 0.01`; `$<4 decimals>` when `usd >= 0.0001`; `$<6 decimals>` otherwise.

## Notes

- The collector daemon updates every 60 seconds. If a recent change to source granularity (PR 2) or subprocess tagging (PR 3) just shipped, the resulting attribution might take one daemon cycle to appear.
- Sessions with `attribution_status='pending'` are still rolled up under `source='unknown'` until they resolve (within 1 hour) or freeze.
- The daily rollup is auto-rebuilt for the current day on each cycle, so `by day` numbers for today are continuously up to date.
