# Agent Patterns

Standard patterns for defining agents in the GENTYR.

## Agent Definition Structure

```markdown
# Agent Name

Brief one-line description of the agent's purpose.

## Core Beliefs

1. First principle this agent operates by
2. Second principle
3. Third principle (3-5 total)

## Capabilities

- What this agent CAN do
- Another capability
- Tools/permissions available

## Limitations

- What this agent CANNOT or SHOULD NOT do
- Boundaries and restrictions

## Task Tracking

This agent uses the `todo-db` MCP server for task management.
- **Section**: SECTION-NAME
- **Creates tasks for**: [list of task types]

## Workflow

### When Invoked
1. Step one
2. Step two
3. Step three

### Completion Criteria
- What must be true before the agent considers its work done

## Integration Points

### Reports To
- Which agent/system this agent reports to

### Receives From
- What triggers this agent

### Spawns
- What agents this agent can spawn

## Example Invocation

\`\`\`
[Task] Brief description of what to do

Context about the situation...
\`\`\`
```

## Required Sections

| Section | Required | Purpose |
|---------|----------|---------|
| Core Beliefs | Yes | Guides agent behavior |
| Capabilities | Yes | Defines scope |
| Limitations | Yes | Prevents overreach |
| Task Tracking | Yes | F003 compliance |
| Workflow | Yes | Step-by-step guide |

## Agent Categories

### Development Agents
- `code-writer`: Implements code changes
- `test-writer`: Creates and updates tests
- `code-reviewer`: Reviews code, manages commits

### Planning Agents
- `investigator`: Research and planning
- `project-manager`: Documentation and cleanup

### Integration Agents
- `integration-researcher`: Platform research
- `integration-frontend-dev`: Frontend connectors
- `integration-backend-dev`: Backend connectors
- `integration-guide-dev`: Setup guides

### Oversight Agents
- `deputy-cto`: CTO assistant, commit review
- `antipattern-hunter`: Spec violation detection
- `repo-hygiene-expert`: Repository structure

### Specialized Agents
- `federation-mapper`: Schema mapping

## Task Section Assignment

| Agent | Section |
|-------|---------|
| test-writer | TEST-WRITER |
| investigator | INVESTIGATOR & PLANNER |
| code-reviewer | CODE-REVIEWER |
| project-manager | PROJECT-MANAGER |

## Agent Communication Pattern

Agents communicate via:

1. **Task Database** - Create tasks for other agents
2. **Agent Reports** - Report issues to deputy-cto
3. **Direct Spawning** - Spawn sub-agents for specific work

```
# Report to deputy-cto
mcp__agent-reports__report_to_deputy_cto({
  reporting_agent: "your-agent-name",
  title: "Issue title",
  summary: "Detailed description",
  category: "architecture|security|blocker|...",
  priority: "low|normal|high|critical"
})
```

## Deputy-CTO Follow-Up Verification System

Tasks created by the deputy-cto have **forced follow-up verification** to ensure work is actually completed, not just dispatched. This is enforced at the MCP level in the `todo-db` server — it cannot be bypassed by agents.

### How It Works

1. **Task creation** — When `deputy-cto` calls `create_task`, the todo-db server:
   - **Rejects** the task if no `description` is provided (hard requirement)
   - Forces `followup_enabled = 1` regardless of what the caller passes
   - Auto-generates a verification prompt from the task's title and description
   - Warns (but does not block) if `followup_enabled: false` was explicitly passed

2. **Task execution** — Any agent picks up and works the task normally

3. **Task completion** — When any agent calls `complete_task`, the todo-db server:
   - Creates a new `[Follow-up]` task automatically
   - Sets `assigned_by: 'system-followup'` on the follow-up
   - Sets `followup_enabled: 0` on the follow-up (prevents infinite chaining)
   - Places it in `followup_section` (defaults to the original task's section, overridable at creation)

4. **Follow-up verification** — The follow-up task contains a verification prompt:
   - Asks the deputy-cto to verify the original task was actually completed
   - If not worked on, the deputy-cto stops (re-spawned later)
   - If partially done, the deputy-cto creates new tasks for remaining work
   - If fully done, the deputy-cto marks the follow-up as complete (no further chaining)

### Enforcement Details

- **Forced creators**: Defined in `FORCED_FOLLOWUP_CREATORS` constant (currently: `['deputy-cto', 'product-manager']`)
- **Description required**: Tasks without descriptions are rejected at the MCP level
- **No opt-out**: Passing `followup_enabled: false` is overridden with a warning
- **No chaining**: Follow-up tasks have `followup_enabled: 0` — completing them does not create another follow-up
- **Cross-section**: Use `followup_section` to route the follow-up to a different section than the original task

### Example

```javascript
// Deputy-CTO creates a task
mcp__todo-db__create_task({
  section: "CODE-REVIEWER",
  title: "Fix SSRF in webhook validation",
  description: "webhook.ts allows arbitrary URLs. Add allowlist validation.",
  assigned_by: "deputy-cto"
})
// → followup_enabled forced to 1, prompt auto-generated

// Agent completes the task
mcp__todo-db__complete_task({ id: "task-uuid" })
// → [Follow-up] Fix SSRF in webhook validation created in CODE-REVIEWER
// → assigned_by: 'system-followup', followup_enabled: 0

// Deputy-CTO verifies the follow-up
// → If done: marks follow-up complete (no further follow-up created)
// → If not done: creates new tasks for remaining work
```

## Core Beliefs Examples

### Good Core Beliefs
- "Tests must validate actual behavior, never be weakened to pass"
- "Security issues are always high priority"
- "One task in_progress at a time"

### Bad Core Beliefs (Too Vague)
- "Write good code" (not actionable)
- "Be helpful" (no specific guidance)
- "Follow best practices" (undefined)

## Workflow Writing Guidelines

1. **Be Specific** - List exact steps, not vague instructions
2. **Include Decision Points** - When to branch or stop
3. **Define Completion** - Clear criteria for "done"
4. **Reference Tools** - Name specific MCP tools to use

### Example Workflow

```markdown
## Workflow

### When Invoked
1. Read the task description from todo-db
2. Mark task as `in_progress`
3. Gather context:
   - Read relevant files using Read tool
   - Check specs using mcp__specs-browser__get_spec
4. Perform the work
5. Verify completion criteria
6. Mark task as `completed`
7. Report any issues via mcp__agent-reports__report_to_deputy_cto

### If Blocked
1. Document the blocker
2. Report to deputy-cto with priority: "blocker"
3. Do NOT mark task as completed
```
