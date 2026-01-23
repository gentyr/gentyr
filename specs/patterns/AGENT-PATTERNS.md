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
