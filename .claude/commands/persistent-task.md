<!-- HOOK:GENTYR:persistent-task -->
# /persistent-task - Create a Persistent Task

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Creates a persistent task — a high-level objective that a dedicated monitor session will drive to completion. The flow refines the CTO's intent into a high-specificity prompt before spawning the monitor.

## Step 1: Understand the Request

Check whether the user invoked with arguments or bare:

- **With arguments** (e.g., `/persistent-task Implement the new auth system with SSO`): use the provided text as the initial description and proceed to Step 2.
- **Bare invocation** (`/persistent-task`): use `AskUserQuestion` to ask:

  > What complex objective would you like to delegate as a persistent task? Describe the end goal and any key constraints or requirements.

  Record the CTO's response as the initial description, then proceed to Step 2.

## Step 2: Research Phase

Spawn an Explore sub-agent to understand the codebase context relevant to the task:

```
Task(
  subagent_type='Explore',
  prompt='Research the codebase to understand the following objective: <description>. Focus on: existing implementations and patterns relevant to the goal, dependencies and integration points, any specs or architectural constraints, and potential implementation approaches. Produce a concise research summary.'
)
```

Wait for the sub-agent to complete before proceeding.

## Step 3: Clarification Loop

Based on the research findings and the initial description, ask the CTO clarifying questions to achieve high specificity. Use `AskUserQuestion` for each round. Ask about:

- **Scope boundaries**: What is explicitly in scope vs. out of scope?
- **Success criteria**: How will we know when this objective is fully complete?
- **Demo involvement**: Does this task involve demo scenarios? If the objective mentions demos, E2E validation, or visual verification, ask explicitly: "Does this involve running demo scenarios? If so, the monitor will use headed video recording and visual frame review to verify success criteria." Set `demo_involved: true` when creating the task if demos are part of the success criteria.
- **Infrastructure access**: Will child agents need to run builds, demos, or access dev servers and secrets? If yes, enable strict infrastructure guidance (`strict_infra_guidance: true`) — agents will receive MCP-only infrastructure instructions with Bash prohibition for infrastructure operations.
- **Constraints**: Any approaches to avoid? Technology or library preferences?
- **Priority areas**: What should be tackled first if there are dependencies between parts?
- **Quality bar**: Testing expectations, performance requirements, backwards compatibility?
- **Timeline**: Any urgency or hard deadlines?

Continue the clarification loop until you are confident you can write a prompt with high specificity. At minimum, you must have clear answers for scope, success criteria, and demo involvement before proceeding.

## Step 4: Draft Finalized Prompt

Present the refined prompt to the CTO using this structure:

```
## Persistent Task: <Short Title>

### Objective
<Clear, specific description of what needs to be accomplished, incorporating all clarifications>

### Scope

**In scope:**
- <item 1>
- <item 2>

**Out of scope:**
- <item 1>

### Success Criteria
- <criterion 1 — specific and verifiable>
- <criterion 2>

### Approach
<Recommended implementation approach based on codebase research>

### Constraints
- <constraint 1>
- <constraint 2>
```

## Step 5: Approval

Use `AskUserQuestion` with `multiSelect: false` and these options:

- **Approve** — Create the persistent task and spawn the monitor session
- **Revise** — Go back to the clarification loop with specific feedback
- **Cancel** — Abort without creating anything

If the CTO selects **Revise**: ask what needs to change, incorporate the feedback, update the prompt, and return to Step 4 with the revised draft.

If the CTO selects **Cancel**: confirm cancellation and stop.

## Step 6: Create and Activate

Once approved:

### 6a. Create the persistent task

```
mcp__persistent-task__create_persistent_task({
  title: "<short title — under 80 characters>",
  prompt: "<full finalized prompt from Step 4>",
  original_input: "<CTO's original description from Step 1>",
  outcome_criteria: "<the success criteria section, as a single string>",
  demo_involved: <true if demos are part of the success criteria, false otherwise>,
  strict_infra_guidance: <true if child agents need strict MCP-only infrastructure access (builds, demos, dev servers, secrets), false otherwise>
})
```

Record the returned `id`.

### 6b. Activate (spawns the monitor session)

```
mcp__persistent-task__activate_persistent_task({ id: "<task_id>" })
```

### 6c. Display confirmation

```
Persistent task created and monitor session spawned.

Task ID: <id>
Title:   <title>
Status:  active

The monitor session will:
  1. Break the objective into sub-tasks
  2. Spawn code-writer, test-writer, and investigator agents as needed
  3. Run user-alignment checks every 3 cycles
  4. Report progress to you every 5 cycles
  5. Signal you when the outcome criteria are met

Use /persistent-tasks to track progress, view sub-tasks, or send amendments.
```

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `mcp__persistent-task__create_persistent_task` | Create task in draft status |
| `mcp__persistent-task__activate_persistent_task` | Draft → active, spawns monitor session |
