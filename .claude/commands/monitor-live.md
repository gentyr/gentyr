<!-- HOOK:GENTYR:monitor-live -->
# /monitor-live - Launch Interactive Persistent Task Monitor

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Opens a persistent task monitor in a **visible Terminal.app window** where the CTO can watch the Claude Code TUI output in real-time and optionally type messages to intervene. All automated behavior (heartbeats, amendment detection, sub-agent spawning) continues working.

If a headless monitor is already running for the task, it is terminated first to prevent duplicates.

Accepts optional argument: `/monitor-live <task-id-prefix>` or bare `/monitor-live`.

---

## Step 1: Resolve Task

**If argument provided** (e.g., `/monitor-live 5439cfd4`):

Call `mcp__persistent-task__list_persistent_tasks({})` and find the task whose ID starts with the provided prefix. If no match or multiple matches, report the error.

**If no argument provided**:

Call `mcp__persistent-task__list_persistent_tasks({})` and display active tasks:

```
| # | ID Prefix | Title                       | Status | Cycles | Heartbeat |
|---|----------|-----------------------------|--------|--------|-----------|
| 1 | 5439cfd4 | AWS one-click demo E2E      | active | 204    | 2m ago    |
| 2 | a1b2c3d4 | Refactor auth middleware     | active | 50     | 1m ago    |
```

Ask the CTO to select one.

**Validate**: The task must be in `active` status. If it is `paused`, ask the CTO if they want to resume it first (call `mcp__persistent-task__resume_persistent_task`). If it is `draft`, `completed`, `cancelled`, or `failed`, report that `/monitor-live` only works with active tasks.

---

## Step 2: Kill Existing Headless Monitor

Read the task record from Step 1. Check `monitor_pid` field.

If `monitor_pid` is set, check if the process is alive:

```bash
kill -0 <monitor_pid> 2>/dev/null && echo "ALIVE" || echo "DEAD"
```

If alive:
```bash
kill <monitor_pid> && sleep 2 && echo "Terminated headless monitor PID <monitor_pid>"
```

If dead or not set, skip this step.

---

## Step 3: Build Command and Launch

### 3a: Generate Agent ID

```bash
AGENT_ID="agent-$(openssl rand -hex 4)-$(date +%s | tail -c 5)"
```

### 3b: Detect Proxy State

Check if the rotation proxy is active:

```bash
PROXY_STATE="$HOME/.claude/rotation-proxy-state.json"
if [ -f "$PROXY_STATE" ]; then
  PROXY_PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PROXY_STATE','utf8')).port||18080)}catch{console.log(18080)}" 2>/dev/null || echo "18080")
  PROXY_RUNNING=$(curl -sf "http://localhost:$PROXY_PORT/health" >/dev/null 2>&1 && echo "true" || echo "false")
else
  PROXY_RUNNING="false"
fi
```

### 3c: Write Launch Script

Write a temporary launch script to `/tmp/gentyr-monitor-<task_id_prefix>.sh`. This avoids shell escaping issues when passing through AppleScript.

The script content should be:

```bash
#!/bin/bash
cd <PROJECT_DIR>

export GENTYR_PERSISTENT_TASK_ID="<full_task_id>"
export GENTYR_PERSISTENT_MONITOR="true"
export GENTYR_INTERACTIVE_MONITOR="true"
export CLAUDE_AGENT_ID="<agent_id>"
export CLAUDE_PROJECT_DIR="<PROJECT_DIR>"

# Proxy env vars (only if proxy is active)
# export HTTPS_PROXY="http://localhost:<port>"
# export HTTP_PROXY="http://localhost:<port>"
# export NO_PROXY="localhost,127.0.0.1"
# export NODE_EXTRA_CA_CERTS="$HOME/.claude/proxy-certs/ca.pem"

exec claude --agent persistent-monitor \
  "[Automation][persistent-monitor][AGENT:$CLAUDE_AGENT_ID] You are the interactive persistent task monitor for \"<task_title>\". Read your full task details: mcp__persistent-task__get_persistent_task({ id: \"$GENTYR_PERSISTENT_TASK_ID\", include_amendments: true, include_subtasks: true }). Then begin your monitoring loop. Persistent Task ID: $GENTYR_PERSISTENT_TASK_ID"
```

Write this script via Bash:

```bash
cat > /tmp/gentyr-monitor-<prefix>.sh << 'SCRIPT_EOF'
<script content>
SCRIPT_EOF
chmod +x /tmp/gentyr-monitor-<prefix>.sh
```

### 3d: Open Terminal Window via AppleScript

```bash
osascript -e 'tell application "Terminal"
  activate
  do script "bash /tmp/gentyr-monitor-<prefix>.sh"
end tell'
```

---

## Step 4: Confirm

Display:

```
Interactive monitor launched for "<task_title>"

  Task ID:  <full_task_id>
  Agent ID: <agent_id>
  Window:   Terminal.app (new window)

The monitor will read its task details and begin the monitoring loop.
You can type messages in the Terminal window to intervene at any time.

If the session dies, the standard revival system will spawn a headless
replacement after ~5 minutes. Re-run /monitor-live to stay interactive.
```

---

## Notes

- **macOS only** — uses Terminal.app via AppleScript. On non-macOS, report that `/monitor-live` requires macOS.
- **No `--dangerously-skip-permissions`** — the CTO retains tool approval control.
- **`--agent persistent-monitor`** must be available in `.claude/agents/`. In target projects this is symlinked from gentyr's `agents/` directory.
- The `GENTYR_INTERACTIVE_MONITOR=true` env var bypasses the interactive-agent-guard so the monitor can spawn sub-agents via Task tool.
- Heartbeat, amendment detection, and cycle tracking work via `persistent-task-briefing.js` which checks `GENTYR_PERSISTENT_TASK_ID` (not `CLAUDE_SPAWNED_SESSION`).
