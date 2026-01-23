# /gentyr - GENTYR Activity Dashboard

Display a comprehensive activity dashboard showing all GENTYR system metrics, agent spawns, hook executions, and Claude usage in a rich ASCII format.

## What to Do

1. Call `mcp__gentyr-dashboard__get_dashboard({ hours: 24 })` to get all dashboard data
2. Format the output as a rich ASCII dashboard following the template below

## Output Format

Present the dashboard with ASCII box-drawing characters for a professional terminal display:

```
================================================================================================================
                                    G E N T Y R   D A S H B O A R D
                               Godlike Entity, Not Technically Your Replacement
================================================================================================================
 Generated: {generated_at}                                                              Period: Last {hours} hours
================================================================================================================

+-----------------------------------+-------------------------------------------+
| SYSTEM HEALTH                     | QUOTA STATUS                              |
+-----------------------------------+-------------------------------------------+
| Autonomous Mode: {status}         | 5-hour  {bar} {pct}% (resets {time})      |
| Protection:      {status}         | 7-day   {bar} {pct}% (resets {time})      |
| Next Automation: {task} ({min}m)  | Sonnet  {bar} {pct}% (resets {time})      |
+-----------------------------------+-------------------------------------------+

+-----------------------------------------------------------------------------------------------+
| AGENT ACTIVITY ({hours}h)                                                                     |
+-----------------------------------------------------------------------------------------------+
| Total Spawns: {spawns_24h} (24h) / {spawns_7d} (7d) / {total_spawns} (all time)               |
|                                                                                               |
| By Type:                               By Hook:                                               |
|   {type} ............... {count}         {hook} ............... {count}                       |
|   {type} ............... {count}         {hook} ............... {count}                       |
|   ...                                    ...                                                  |
|                                                                                               |
| Recent:                                                                                       |
|   * {time} {type} - {description}                                                             |
|   * {time} {type} - {description}                                                             |
|   * {time} {type} - {description}                                                             |
+-----------------------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------------------+
| HOOK EXECUTIONS ({hours}h)                                                                    |
+-----------------------------------------------------------------------------------------------+
| Total: {total} executions | Success Rate: {rate}%                                             |
|                                                                                               |
| Hook                    Total  Success  Fail  Skip   Avg Time                                 |
| -----------------------+------+--------+------+------+----------                              |
| {hook}                  {tot}   {ok}     {fail} {skip}  {time}                                |
| {hook}                  {tot}   {ok}     {fail} {skip}  {time}                                |
| ...                                                                                           |
|                                                                                               |
| Recent Failures:                                                                              |
|   * {time} {hook} - {error}                                                                   |
+-----------------------------------------------------------------------------------------------+

+-----------------------------------+-------------------------------------------+
| TASK PIPELINE                     | CTO QUEUE                                 |
+-----------------------------------+-------------------------------------------+
| Pending: {n} | In Progress: {n}   | Pending Questions: {n}                    |
| Completed ({hours}h): {n}         | Rejections: {n}                           |
| Stale (>30min): {n}               | Pending Reports: {n}                      |
|                                   |                                           |
| By Section:                       | COMMITS: {ALLOWED/BLOCKED}                |
|   {section}    {p} | {i} | {c}    |                                           |
|   {section}    {p} | {i} | {c}    | Recent Escalations:                       |
|   ...                             |   * {title}                               |
+-----------------------------------+-------------------------------------------+

+-----------------------------------------------------------------------------------------------+
| TOKEN USAGE ({hours}h)                                                                        |
+-----------------------------------------------------------------------------------------------+
| Input: {input} | Output: {output} | Cache Read: {cache_read} | Cache Write: {cache_write}     |
| Total: {total} tokens | Cache Hit Rate: {rate}%                                               |
|                                                                                               |
| Sessions: {task} task-triggered | {user} user-triggered | {total} total                       |
+-----------------------------------------------------------------------------------------------+

+-----------------------------------+-------------------------------------------+
| API KEY HEALTH                    | COMPLIANCE CHECKER                        |
+-----------------------------------+-------------------------------------------+
| Active Key: {id}                  | Global Agents Today: {n}                  |
| Total: {n} | Usable: {n}          | Local Agents Today: {n}                   |
| Rotation Events ({hours}h): {n}   | Last Run: {time}                          |
|                                   |                                           |
| Key        5h    7d    Status     | Files Needing Check: {n}                  |
| {id}       {pct}  {pct}  {status} |                                           |
+-----------------------------------+-------------------------------------------+

================================================================================================================
 Run /cto-report for detailed metrics | /deputy-cto for interactive briefing
================================================================================================================
```

## Formatting Guidelines

### Progress Bars
Create visual progress bars for quota percentages:
- Use filled blocks for used portion: `[========  ]` for ~80%
- Scale: 10 characters total for the bar portion

### Status Indicators
- Enabled/Active: `ENABLED` or `ACTIVE`
- Disabled: `DISABLED`
- Protected: `PROTECTED`
- Unprotected: `UNPROTECTED`
- Blocked: `BLOCKED` (use caps for emphasis)
- Allowed: `ALLOWED`

### Number Formatting
- Format large numbers with K/M suffixes: 2.4M, 890K
- Show percentages with one decimal: 94.2%
- Show time durations appropriately: 1.2s, 8.5s, 45.2s

### Time Formatting
- Recent times: relative format like "14:12", "6h ago"
- Reset times: "2.3h", "4.2d"

### Colors (Terminal)
If possible, indicate status through text:
- Success/Good: Plain text
- Warning: Add "(warning)" suffix
- Error/Critical: Add "(CRITICAL)" suffix

## Handling Missing Data

- If api_keys is null: Show "API key rotation not configured"
- If compliance is null: Show "Compliance checker not configured"
- If quota has error: Show "Quota: {error message}"
- If no recent failures: Show "No recent failures"
- If no escalations: Show "No pending escalations"

## Notes

- This is a **read-only dashboard** - it does not modify any state
- For CTO decision-making, use `/deputy-cto` instead
- For detailed metrics report, use `/cto-report`
- The dashboard aggregates data from 9+ sources in real-time
