<!-- HOOK:GENTYR:focus-mode -->
# /focus-mode — DEPRECATED, use /automation-rate

Focus mode has been replaced by the automation rate system.

- `focus mode on` = `/automation-rate none`
- `focus mode off` = `/automation-rate low`

## Step 1: Translate to Automation Rate

If the user passed an argument:
- `/focus-mode on` → call `mcp__agent-tracker__set_automation_rate({ rate: "none" })`
- `/focus-mode off` → call `mcp__agent-tracker__set_automation_rate({ rate: "low" })`

If no argument was provided (bare `/focus-mode`):
1. Call `mcp__agent-tracker__get_automation_rate()` to check current state
2. If current rate is `none`, set to `low` (toggle off)
3. If current rate is anything else, set to `none` (toggle on)

## Step 2: Show Result

Display the result and inform the user about `/automation-rate`:

```
[DEPRECATED] Focus mode has been replaced by /automation-rate.

Automation rate set to: <rate>

Use /automation-rate [none|low|medium|high] for finer control:
  none   — Blocks all automated spawns (= focus mode on)
  low    — 5x slower (DEFAULT, = focus mode off)
  medium — 2x slower
  high   — Baseline rates
```
