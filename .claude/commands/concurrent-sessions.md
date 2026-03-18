<!-- HOOK:GENTYR:concurrent-sessions -->
# /concurrent-sessions - Configure Max Concurrent Sessions

$ARGUMENTS

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Behavior

If no argument is provided, show the current session queue status by calling `mcp__show__show_session_queue()`.

If a number is provided (e.g., `/concurrent-sessions 15`):
1. Call `mcp__agent-tracker__set_max_concurrent_sessions({ max: <number> })`
2. Then call `mcp__show__show_session_queue()` to show the updated status

Valid range: 1-50. Default is 10.
