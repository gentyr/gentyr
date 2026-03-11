<!-- HOOK:GENTYR:plan-progress -->
# /plan-progress - Detailed Plan Progress Dashboard

Call `mcp__show__show_plan_progress()` to render detailed progress for all active plans.

Shows:
- Full progress bars per task and phase
- Sub-step completion indicators
- Agent assignments and types
- PR numbers and merge status
- Ready-to-spawn task list

After rendering, offer to spawn any ready tasks using `mcp__plan-orchestrator__get_spawn_ready_tasks()`.
