You have pending TODO items in the todo-db that need attention. Process up to 3 items at a time.

NOTE: This is an automated [Task] session. You will get one continuation prompt after your first response to ensure all work is complete.

## MANDATORY SUB-AGENT REQUIREMENT

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making code changes without the code-writer sub-agent
- Making test changes without the test-writer sub-agent
- Skipping investigation before implementation
- Skipping code-reviewer after any code/test changes
- Skipping project-manager at the end

**ALL file modifications MUST go through the appropriate sub-agent.** This is a strict architectural requirement that cannot be bypassed.

## SUB-AGENT DEFINITIONS

| Sub-Agent | Purpose | When to Use |
|-----------|---------|-------------|
| **investigator** | Research, understand, plan | FIRST - Before any implementation |
| **code-writer** | Modify production code | When production code needs changes |
| **test-writer** | Modify test files | When tests need creation/modification |
| **code-reviewer** | Review all changes | AFTER any code-writer or test-writer |
| **project-manager** | Update documentation, cleanup | LAST - Always mandatory |

## MANDATORY SEQUENCE

1. **investigator** (parallel, up to 3) - Research each TODO item, understand the issue, plan the solution
2. **code-writer** (if production changes needed) - Implement fixes
3. **test-writer** (if test changes needed) - Add/modify tests
4. **code-reviewer** (parallel) - Review all changes
5. **project-manager** (mandatory) - Cleanup and documentation

## WHICH SUB-AGENT?

| Task Type | Sub-Agent |
|-----------|-----------|
| Investigation/research/planning | investigator |
| Modifying production code | code-writer (MANDATORY) |
| Modifying test files | test-writer (MANDATORY) |
| After any code or test changes | code-reviewer (MANDATORY) |
| Finishing the session | project-manager (MANDATORY) |

## MCP TODO-DB COORDINATION

Multiple Claude agents work on this codebase concurrently. The todo-db MCP server prevents conflicts:

1. **BEFORE starting**: `mcp__todo-db__start_task({ id: "task-uuid" })` - Mark task as in-progress
2. **DURING work**: `mcp__todo-db__create_task(...)` - Add new discoveries immediately
3. **AFTER completing**: `mcp__todo-db__complete_task({ id: "task-uuid" })` - Mark task as completed

## GETTING YOUR TASKS

First, list pending tasks from your section:

```
mcp__todo-db__list_tasks({ status: "pending", limit: 10 })
```

Then select up to 3 items to process, prioritizing:
1. P0 CRITICAL
2. P1 HIGH
3. P2 MEDIUM
4. P3 LOW
5. Oldest created timestamp

## VALID SECTIONS

Tasks are organized into these sections:
- `TEST-WRITER` - Test-related tasks
- `INVESTIGATOR & PLANNER` - Research and planning tasks
- `CODE-REVIEWER` - Code review tasks
- `PROJECT-MANAGER` - Documentation and cleanup tasks

