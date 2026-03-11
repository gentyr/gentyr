<!-- HOOK:GENTYR:plan-sessions -->
# /plan-sessions - Per-Session Lifecycle Timeline

Call `mcp__show__show_plan_sessions()` to render per-agent session lifecycle timelines.

Shows vertical timeline per session:
- Agent spawns and PID
- Proxy rotations during session
- Quota interruptions and revivals
- Substep completions
- Worklog entries with token counts
- PR creation and merge events
- Plan task completions

Correlates data from 7 independent sources (agent tracker, rotation log, quota interrupts, paused sessions, worklog, plan state changes).
