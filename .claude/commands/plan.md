<!-- HOOK:GENTYR:plan -->
# /plan - Plan Overview & Management

## Modes

### Bare mode (`/plan`)

Call `mcp__show__show_plans()` to render all active plans with phase progress bars.

After rendering, present an action menu:
1. **View details** — call `mcp__show__show_plan_progress()` for detailed progress
2. **Spawn ready tasks** — call `mcp__plan-orchestrator__get_spawn_ready_tasks({ plan_id: "..." })` then use `force_spawn_tasks` to spawn them
3. **Create new plan** — ask for a description, then call `mcp__plan-orchestrator__create_plan()`
4. **View timeline** — call `mcp__show__show_plan_timeline()`
5. **View audit** — call `mcp__show__show_plan_audit()`

### Description mode (`/plan <description>`)

Create a new plan from the provided description:
1. Break the description into logical phases and tasks using AI reasoning
2. Call `mcp__plan-orchestrator__create_plan({ title: "...", phases: [...] })` with the structured plan
3. Add inter-phase dependencies using `mcp__plan-orchestrator__add_dependency()`
4. Activate the plan using `mcp__plan-orchestrator__update_plan_status({ plan_id: "...", status: "active" })`
5. Show the result using `mcp__plan-orchestrator__plan_dashboard({ plan_id: "..." })`

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```
