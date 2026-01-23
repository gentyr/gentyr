# /cto-report - Generate CTO Status Report

Generate a comprehensive CTO status report using the `mcp__cto-report__get_report` tool.

## What to Do

1. Call `mcp__cto-report__get_report({ hours: 24 })` to get the full report data
2. Format the output as a clean markdown summary

## Output Format

Present the report with these sections:

```markdown
## CTO Status Report

**Generated:** {timestamp}
**Period:** Last {hours} hours

### Quota Status

| Bucket | Usage | Resets In |
|--------|-------|-----------|
| 5-hour | {bar} {percent}% | {hours}h |
| 7-day  | {bar} {percent}% | {days}d |

{If error fetching quota, show: "Quota: Unable to fetch ({error})"}

### Autonomous Deputy CTO
- Status: {ENABLED/DISABLED}
- Next run: {in X minutes / ready / N/A}

### Token Usage (24h)

| Type | Tokens | Description |
|------|--------|-------------|
| Input | {formatted} | Fresh tokens processed |
| Output | {formatted} | Generated response tokens |
| Cache read | {formatted} | Reused from cache (90% cheaper) |
| Cache write | {formatted} | Added to cache (25% more expensive) |

**Effective input:** {input + cache_read + cache_write} tokens
**Cache hit rate:** {cache_read / (input + cache_read) * 100}%

{Note: High cache read is good - it means CLAUDE.md, system prompts, and conversation history are being efficiently reused across API calls.}

### Session Activity (24h)
- Hook-triggered sessions: {count}
  - todo-maintenance: {n}
  - pre-commit-review: {n}
  - compliance-checker: {n}
  - antipattern-hunter: {n}
  - schema-mapper: {n}
  - plan-executor: {n}
  - hourly-automation: {n}
  - jest-reporter: {n}
  - playwright-reporter: {n}
  {Only show hook types with count > 0}
- User-triggered sessions: {count}
- **Total sessions:** {total}

### Pending CTO Items
- CTO questions: {count}
- Commit rejections: {count}
- Unread agent reports: {count}
- **Commits blocked:** {YES/NO}

{If commits blocked, add: "Use /deputy-cto to address blocking rejections."}

### Task Status

| Section | Pending | In Progress | Completed |
|---------|---------|-------------|-----------|
| {section} | {n} | {n} | {n} |
...

**Completed (24h):** {total} tasks
- {breakdown by section}

---
*Run /deputy-cto for interactive briefing session*
```

## Notes

- This is a **read-only report** - it does not modify any state
- For interactive decision-making, use `/deputy-cto` instead
- The report uses the same data sources as the session-start notification
- Quota data is fetched live from Anthropic API using OAuth credentials
