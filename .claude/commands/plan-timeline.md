<!-- HOOK:GENTYR:plan-timeline -->
# /plan-timeline - State Change Timeline

Call `mcp__show__show_plan_timeline()` to render chronological plan state changes.

Shows compact arrow-format timeline:
- Task completions and status transitions
- Agent spawns and assignments
- Dependency unlocks (tasks becoming ready)
- Sub-step completions (indented with `└`)
- Phase completions

Events are shown for the last 24 hours by default.
