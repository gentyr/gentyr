<!-- HOOK:GENTYR:cto-dashboard -->
# /cto-dashboard - Live CTO Dashboard

Opens a real-time CTO dashboard in a new Terminal.app window. The dashboard polls live data every 3 seconds and supports keyboard navigation.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Steps

1. Resolve the framework directory and project directory:

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
DASHBOARD_DIR="$GENTYR_DIR/packages/cto-dashboard-live"
```

2. Build the dashboard if dist is stale or missing:

```bash
if [ ! -f "$DASHBOARD_DIR/dist/index.js" ] || [ "$DASHBOARD_DIR/src/index.tsx" -nt "$DASHBOARD_DIR/dist/index.js" ]; then
  cd "$DASHBOARD_DIR" && npm run build 2>/dev/null
fi
```

3. Open Terminal.app with the live dashboard:

```bash
osascript -e "tell application \"Terminal\"
  do script \"CLAUDE_PROJECT_DIR='$PROJECT_DIR' node '$DASHBOARD_DIR/dist/index.js'\"
  activate
end tell"
```

4. Report to the user:

```
Live CTO Dashboard opened in Terminal.app.

Keys: ↑↓ select sessions · Enter join · h home · 1 Ops · 2 Details · q quit
```

## Notes

- **macOS only** — uses Terminal.app via AppleScript
- Dashboard reads from `$CLAUDE_PROJECT_DIR` databases (session-queue.db, persistent-tasks.db, todo.db, worklog.db, etc.)
- Data refreshes every 3 seconds
- Press Enter on a running session to kill the headless process and resume it interactively in a new Terminal.app window
- Use `--mock` flag for testing with fake data: `node $DASHBOARD_DIR/dist/index.js --mock`
