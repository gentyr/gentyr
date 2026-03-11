<!-- HOOK:GENTYR:plan-audit -->
# /plan-audit - Agent Work Audit

Call `mcp__show__show_plan_audit()` to render agent metrics for all active plans.

Shows:
- Per-agent metrics table (tasks assigned, completed, PRs merged)
- Phase efficiency breakdown with progress bars
- Identifies stalled or underperforming agents

After rendering, offer to spawn replacement agents for stalled tasks.
