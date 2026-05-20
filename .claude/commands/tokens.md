<!-- HOOK:GENTYR:tokens -->
# /tokens — Token Usage Report

Renders Claude token consumption from `.claude/state/token-usage.db` (populated by the `token-usage-collector` daemon).

## Categorization model (PR B/C)

The default grouping dimension is **`work_category`** — the kind of work a session is doing (plan-manager, persistent-monitor, universal-auditor, task-runner, agent-tool-subagent, …). A session's `work_category` survives revival: a revived persistent monitor stays labeled `persistent-monitor`, not `session-queue-reaper`. Revival is captured separately via `is_revival` / `revived_by` / `revival_count`. The legacy `source` (spawner code path) is still available but no longer the default.

## Arguments

`/tokens [range] [by <dimension>] [filter <key>=<value>] [revivals|originals|top|health]`

| Argument | Values | Default |
|----------|--------|---------|
| range | `1h` / `24h` / `7d` / `30d` / `all` | `24h` |
| by    | `work_category` (default) / `agent_type` / `spawn_origin` / `revived_by` / `source` / `lane` / `model` / `category` / `day` / `persistent_task` / `plan` | `work_category` |
| filter | `source=…` `work_category=…` `spawn_origin=…` `revived_by=…` `model=…` `lane=…` `persistent_task=N` `plan=…` | none |
| revivals | switches to revival-cost-summary mode (revived vs original spend) | off |
| originals | restricts results to non-revival sessions (`only_originals=true`) | off |
| top    | switches to top-sessions mode (returns hottest sessions) | off |
| health | switches to attribution health diagnostic | off |

Examples:
- `/tokens` — last 24h, grouped by work_category (default)
- `/tokens 7d` — last 7 days, grouped by work_category
- `/tokens 24h by agent_type` — drill into the specific agent type (user-alignment / investigator / code-writer / …)
- `/tokens 24h by spawn_origin` — the original spawner of the work, chasing through revivals
- `/tokens 7d by revived_by` — which revival mechanisms are most expensive
- `/tokens 24h revivals` — how much we spent on resurrection vs original work in the last 24h
- `/tokens 24h originals` — exclude revivals to see the cost of new work only
- `/tokens 24h by lane` — group by `persistent` / `audit` / `gate` / `automated` / `standard` / `subprocess` / `subagent` / `interactive`
- `/tokens 1h by model` — Opus vs Sonnet vs Haiku split
- `/tokens 24h filter work_category=plan-manager` — show only plan-manager spend
- `/tokens 24h filter revived_by=session-queue-reaper by agent_type` — what kinds of work the reaper has been resurrecting
- `/tokens 24h top` — top 20 most expensive sessions
- `/tokens health` — attribution coverage diagnostic

## Workflow (for the assistant)

1. Parse the arguments. Defaults: `range='24h'`, `group_by='work_category'`, `limit=50`.
2. **Health mode**: call `mcp__agent-tracker__token_attribution_health()`. Render: total session attributions, resolved/pending/unknown counts, oldest pending age in minutes, untagged subprocess count. Stop.
3. **Top mode**: call `mcp__agent-tracker__top_token_sessions({ range, limit: 20 })`. Render a table: `session_id` (first 8 chars), `source`, `agent_type`, `total_tokens` (human-readable: `K`/`M`), `cost_usd`, `duration_minutes`. Stop.
4. **Revivals mode**: call `mcp__agent-tracker__revival_cost_summary({ range })`. Render the revival-vs-original totals (tokens, cost, sessions, % of total) and a by-`revived_by` breakdown table. Stop.
5. **Default mode**: call `mcp__agent-tracker__query_token_usage({ range, group_by, limit: 50, ...filters })`. The MCP tool returns:
   ```ts
   {
     range: { start_ms, end_ms, range_key },
     total: { tokens, cost_usd, sessions, messages },
     rows: [{ group_value, sessions, messages, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, pct_of_total, top_model }],
     group_by,
     category_descriptions: { /* present when group_by='work_category' */ }
   }
   ```
6. **Header**: one-line summary — e.g. `Last 24h — grouped by work_category — total: 47.3M tok / $284.12 / 192 sessions`.
7. **Category legend** (when `group_by='work_category'` only): underneath the header, render the `category_descriptions` returned by the tool as a short bullet list. Skip when grouping by other dimensions. Example:
   ```
   Categories in this view:
     plan-manager           — Plan orchestrators (one persistent monitor per active plan)
     persistent-monitor     — Long-running orchestrators for persistent tasks
     universal-auditor      — Independent task-completion verifier (audit lane)
     agent-tool-subagent    — Task tool sub-agents (user-alignment, investigator, code-writer, ...)
     compaction-subagent    — /compact sub-process (Claude Code auto-compaction)
     ...
   ```
8. **Table + bar chart**: render a sortable table with one row per group, ordered by `total_tokens` desc. Columns: `group_value`, `sessions`, `tokens` (human), `cost`, `% of total`, `top_model`. Underneath the table, render a horizontal bar chart for the top 10 rows. Compute bar width `= round(row.total_tokens / max.total_tokens * 40)` (40 char wide). Use `█` for filled and `░` for empty.
   ```
   work_category                                  tokens     cost      bar                                          %
   task-runner                                    18.2M     $94.40    ████████████████████████████████████████  100%
   persistent-monitor                             11.7M     $82.10    █████████████████████████░░░░░░░░░░░░░░░   64%
   agent-tool-subagent                             6.4M     $41.20    ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░   35%
   universal-auditor                               2.1M      $1.68    █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   12%
   compaction-subagent                             1.8M     $11.40    ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   10%
   ```
9. If `rows.length === 0`, render a short message: "No token usage recorded in this range. If the collector daemon was just installed, wait ~1 minute for the first scan cycle."

## Drill-down recipes

- **"Who's the most expensive subagent type?"** → `/tokens 24h by agent_type filter work_category=agent-tool-subagent`
- **"How much are revivals costing?"** → `/tokens 24h revivals`
- **"Where did this work come from originally?"** → `/tokens 7d by spawn_origin`
- **"What's spending Opus tokens?"** → `/tokens 24h by work_category filter model=claude-opus-4-7`

## Formatters

- `formatTokens(n)`: returns `${n}` if `< 1000`, `${(n/1000).toFixed(1)}K` if `< 1_000_000`, `${(n/1_000_000).toFixed(1)}M` otherwise.
- `formatCost(usd)`: `$0.00` when `usd === 0`; `$<2 decimals>` when `usd >= 0.01`; `$<4 decimals>` when `usd >= 0.0001`; `$<6 decimals>` otherwise.

## Notes

- The collector daemon updates every 60 seconds. After PR A/B/C ships, the first cycle on each existing DB runs a one-time backfill that populates the new `work_category`/`spawn_origin`/`is_revival`/`revived_by`/`revival_count` columns from stored source + agent_type + metadata — no JSONL re-reads required.
- Sessions with `attribution_status='pending'` are still rolled up under `source='unknown'` until they resolve (within 1 hour) or freeze.
- The daily rollup is auto-rebuilt for the current day on each cycle, so `by day` numbers for today are continuously up to date.
- Granularity for Agent-tool subagents (user-alignment, investigator, code-writer, code-reviewer, test-writer, …) is preserved in `agent_type`; `work_category` collapses them to `agent-tool-subagent` for grouped reports. Pivot by `agent_type` (with optional `filter work_category=agent-tool-subagent`) to see each subagent type individually.
