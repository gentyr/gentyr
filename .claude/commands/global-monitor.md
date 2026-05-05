<!-- HOOK:GENTYR:global-monitor -->
# /global-monitor - Toggle Global Deputy-CTO Alignment Monitor

Controls the always-on deputy-CTO session that continuously monitors all active sessions
for CTO intent alignment. The global monitor is **enabled by default** (opt-out).

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Usage

- `/global-monitor` — Show current status (task ID, PID, last heartbeat)
- `/global-monitor on` — Enable the global monitor + create/activate the persistent task
- `/global-monitor off` — Disable the global monitor + pause the persistent task

## Step 1: Determine the Argument

Parse the argument after `/global-monitor`:
- No argument → **Status Only** mode
- `on` → **Enable** mode
- `off` → **Disable** mode
- Any other argument → Show error and print usage

## Status Only Mode (no argument)

1. Call `mcp__agent-tracker__get_automation_toggles()` to get the `globalMonitorEnabled` state
2. Call `mcp__persistent-task__list_persistent_tasks()` and find the task with `task_type: "global_monitor"` in its metadata
3. Display:

If the task exists and is active:
```
Global Deputy-CTO Monitor: ACTIVE

Task ID:        <task-id>
Status:         active
Monitor PID:    <pid or "DEAD">
Last Heartbeat: <elapsed>
Toggle:         globalMonitorEnabled = true

The monitor runs a 5-minute polling loop, checking all active sessions
for CTO intent alignment and sending corrective signals to drifting agents.

Commands:
  /global-monitor off   Pause the monitor and disable auto-creation
```

If disabled:
```
Global Deputy-CTO Monitor: DISABLED

The global monitor is toggled off. No persistent task will be created.

Commands:
  /global-monitor on    Enable the monitor (creates persistent task if needed)
```

If the task exists but is paused/cancelled/completed:
```
Global Deputy-CTO Monitor: INACTIVE

Task ID: <task-id>
Status:  <status>

The persistent task exists but is not running.

Commands:
  /global-monitor on    Resume/re-create the monitor
  /global-monitor off   Disable auto-creation entirely
```

## Enable Mode (/global-monitor on)

1. Call `mcp__agent-tracker__set_automation_toggle({ feature: "globalMonitorEnabled", enabled: true })`
2. Call `mcp__persistent-task__list_persistent_tasks()` and look for a task with `task_type: "global_monitor"` in metadata
3. If a task exists with status `paused`:
   - Call `mcp__persistent-task__resume_persistent_task({ id: "<task-id>" })`
   - Display: "Global monitor resumed. Monitor session will be spawned automatically."
4. If a task exists with status `active`:
   - Display: "Global monitor is already active. No action needed."
5. If no task exists (or task is in terminal state):
   - Display: "Global monitor enabled. The hourly automation will create the persistent task and spawn the monitor on the next 5-minute cycle."

## Disable Mode (/global-monitor off)

1. Call `mcp__agent-tracker__set_automation_toggle({ feature: "globalMonitorEnabled", enabled: false })`
2. Call `mcp__persistent-task__list_persistent_tasks()` and look for a task with `task_type: "global_monitor"` in metadata
3. If a task exists with status `active`:
   - Call `mcp__persistent-task__pause_persistent_task({ id: "<task-id>" })`
   - Display: "Global monitor paused and disabled. The monitor session will be stopped."
4. If a task exists with status `paused`:
   - Display: "Global monitor already paused. Toggle set to disabled."
5. If no task exists:
   - Display: "Global monitor disabled. No persistent task will be auto-created."

## What the Global Monitor Does

When active, the deputy-CTO runs in continuous alignment monitoring mode:

1. **Enumerates** all active tasks and persistent tasks every 5 minutes
2. **Dispatches** user-alignment sub-agents (max 3 concurrent) to verify work matches CTO intent
3. **Reads** alignment results and sends corrective signals to drifting agents
4. **Detects** zombie sessions (alive >2h with no recent tool calls)
5. **Oversees** stuck audit gates

Escalation framework:
- Minor drift: signal to the agent (~50%)
- Moderate misalignment: correction task (~35%)
- Significant drift: submit_bypass_request (~15%)
