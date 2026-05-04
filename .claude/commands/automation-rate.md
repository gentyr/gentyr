<!-- HOOK:GENTYR:automation-rate -->
# /automation-rate — Set Automation Spawn Rate

Controls how aggressively background automations run. Four levels:

| Rate | Multiplier | Effect |
|------|-----------|--------|
| `none` | Blocked | No automated agents spawn (CTO/critical/persistent still allowed) |
| `low` | 5x slower | **DEFAULT** — Conservative automation |
| `medium` | 2x slower | Moderate automation |
| `high` | 1x (baseline) | Full-speed automation |

Infrastructure operations (session reaping, worktree cleanup, heartbeat checks) are unaffected by the rate — only agent-spawning automations are throttled.

## Step 1: Check Arguments

If the user passed an argument (e.g., `/automation-rate high`), skip to Step 2.

If bare `/automation-rate` with no argument:
1. Call `mcp__agent-tracker__get_automation_rate()`
2. Display the current state and the rate table above
3. Stop — do not change anything

## Step 2: Set the Rate

Call `mcp__agent-tracker__set_automation_rate({ rate: "<argument>" })` where `<argument>` is one of `none`, `low`, `medium`, `high`.

## Step 3: Show Result

Display:

```
Automation rate: <RATE>

  none   — Blocks all automated spawns
  low    — 5x slower (DEFAULT)    <-- active
  medium — 2x slower
  high   — Baseline rates

Infrastructure (session reaper, worktree cleanup, heartbeats) always runs.
```

Mark the active rate with `<-- active`.
