<!-- HOOK:GENTYR:focus-mode -->
# /focus-mode - Toggle Focus Mode

Blocks ALL automated agent spawning except CTO-directed work, persistent task monitors,
and session revivals. Use when you want to dedicate all queue slots and API quota to
specific tasks without background automation interfering.

## Step 1: Check Current State

Call the `get_focus_mode` MCP tool on the `agent-tracker` server:

```
mcp__agent-tracker__get_focus_mode()
```

This returns `{ enabled, enabledAt, enabledBy, allowedSources }`.

## Step 2: Toggle to Opposite State

Based on the current state, toggle to the opposite using the `set_focus_mode` MCP tool:

- If currently **ENABLED** → call `mcp__agent-tracker__set_focus_mode({ enabled: false })`
- If currently **DISABLED** → call `mcp__agent-tracker__set_focus_mode({ enabled: true })`

If the user passed an argument (`on` or `off`), use that instead of toggling:
- `/focus-mode on` → call `mcp__agent-tracker__set_focus_mode({ enabled: true })`
- `/focus-mode off` → call `mcp__agent-tracker__set_focus_mode({ enabled: false })`

## Step 3: Show Result

Display the new state clearly:

**If focus mode is now ENABLED:**
```
Focus mode: ENABLED

ALLOWED (will still spawn):
  - CTO-priority sessions (priority: cto or critical)
  - Persistent task monitors (lane: persistent)
  - Session revivals (lane: revival)
  - Task gate agents (lane: gate)
  - Audit agents (lane: audit)
  - Manual CTO spawns via /spawn-tasks (source: force-spawn-tasks)
  - Persistent task spawner (source: persistent-task-spawner)
  - Inline session revival (source: stop-continue-hook)
  - Dead monitor revival (source: session-queue-reaper)
  - Children of persistent tasks (metadata.persistentTaskId set)

BLOCKED (will be rejected at enqueue):
  - Hourly automation task runners
  - Demo failure repair agents
  - AI feedback agents
  - Antipattern hunters
  - Compliance checkers
  - Lint fixers
  - CLAUDE.md refactors
  - Alert escalation agents
  - Plan executors
  - Workstream managers
  - All other background automation

Run /focus-mode again to disable.
```

**If focus mode is now DISABLED:**
```
Focus mode: DISABLED

All automated agent spawning is now unrestricted.
Background automation will resume on the next hourly cycle.
```
