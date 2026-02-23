<!-- HOOK:GENTYR:toggle-automation -->
# /toggle-automation-gentyr - Toggle GENTYR Automation

Toggles the GENTYR automation service between active and paused states. The persistent service (launchd/systemd) keeps running but does nothing when paused.

The prefetch hook has pre-gathered the current automation state and injected it as `[PREFETCH:toggle-automation]` context above. Use that data for Step 1 instead of calling the MCP tool. If the prefetch data is missing, fall back to the MCP call.

## What This Controls

The automation service runs every 10 minutes and handles:
- Report triage (deputy-cto reviews pending agent reports)
- Lint checking and auto-fixing
- Task runner (processes pending TODO items)
- Preview -> Staging promotion pipeline
- Staging -> Production promotion pipeline
- Staging health monitoring
- Production health monitoring
- Standalone antipattern hunting
- Standalone compliance checking
- CLAUDE.md size refactoring

When **paused**, the service still fires every 10 minutes but immediately exits without doing anything.

## Flow

### Step 1: Check Current Status

```javascript
mcp__deputy-cto__get_autonomous_mode_status()
```

Display the current state to the user:
- Whether automation is enabled or disabled
- When it was last modified and by whom

### Step 2: Toggle

Use `AskUserQuestion` to confirm the action:
- **Question:** "Automation is currently {ENABLED/DISABLED}. What would you like to do?"
- **Header:** "Automation"
- **Options:**
  - "Pause all automation" (if currently enabled)
  - "Resume all automation" (if currently disabled)
  - "Show detailed status" (shows last log entries)

If "Show detailed status":
- Read the last 30 lines of `.claude/hourly-automation.log`
- Read `.claude/hourly-automation-state.json` for last run timestamps
- Display summary of each automation's last run time and next scheduled run
- Return to Step 2

If toggling:

```javascript
mcp__deputy-cto__toggle_autonomous_mode({ enabled: true/false })
```

### Step 3: Confirm

Display the new state:
```
GENTYR Automation: {ENABLED/PAUSED}

The persistent service (launchd) continues running.
{If paused: It will check every 10 minutes but take no actions until re-enabled.}
{If enabled: Automations will resume on the next 10-minute cycle.}
```

## Important

- This does NOT stop or remove the launchd/systemd service
- This only sets `enabled: false` in `.claude/autonomous-mode.json`
- The service reads this config on every run and skips all work when disabled
- Individual automations can also be toggled separately in `autonomous-mode.json`
- To fully remove the service, resolve `GENTYR_DIR` first (same as `/setup-gentyr`): `$GENTYR_DIR/scripts/setup-automation-service.sh remove`
