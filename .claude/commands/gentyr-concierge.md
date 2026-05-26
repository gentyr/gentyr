<!-- HOOK:GENTYR:gentyr-concierge -->
# /gentyr-concierge — Ask the GENTYR Concierge

Get concrete, citation-backed guidance on which GENTYR systems to use for a task. Use this when you (or the user) is unsure which primitive fits ("plan vs persistent task vs todo task?"), how to perform a common operation ("how do I add an MCP server?"), or wants a quick "how do I X with GENTYR?" answer.

The concierge is a read-only advisor backed by `agents/gentyr-concierge.md` (decision trees, workflow recipes, agent/MCP/command rosters, top confusion patterns, and gotchas). It advises; the caller executes.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Step 1 — Capture the question

- If `$ARGUMENTS` is non-empty, use it verbatim as the question.
- Otherwise: use `AskUserQuestion` with **one** free-text question — "What GENTYR question can I help with?" — and use the user's answer.

## Step 2 — Answer inline (default path)

You (the interactive session) already have full read access. Inline-answer mode is faster than spawning a sub-agent and uses the conversation context already loaded.

1. Read the concierge's content into context:
   ```
   Read: $GENTYR_DIR/agents/gentyr-concierge.md
   ```
   This loads the decision trees (Section 6), agent roster (Section 7), MCP server roster (Section 8), slash command roster (Section 9), workflow recipes (Section 10), confusion patterns (Section 11), and gotchas (Section 12) into context.

2. Apply the concierge's workflow (Section 4 of its body):
   - Identify the GENTYR category the question touches (Section 5 routing table)
   - Check Sections 5–12 of the loaded agent body FIRST — most questions are answered without any further reading
   - If deeper detail is needed, Read the matching `$GENTYR_DIR/docs/*.md` section per the Section 3 priority order
   - For questions about live project state, call read-only MCP introspection tools (`list_*`, `get_*`, `peek_session`, `browse_session`, `inspect_persistent_task`)
   - Cite file:line for everything

3. Render the response using the concierge's mandatory Output Format:

```
## SUMMARY
One or two sentences.

## RECOMMENDED PATH
1. Concrete numbered steps with exact tool calls / commands / args.

## TOOLS & COMMANDS
- mcp__<server>__<tool>({ ... })
- /<slash-command> <args>
- Task(subagent_type: '<name>')
- bash: <command>   (read-only only)

## GOTCHAS
- Known pitfalls

## REFERENCES
- file:line citations
```

## Step 3 — Sub-agent path (alternative)

If the question is large enough that you'd rather isolate it (e.g., a long research question that doesn't belong in the interactive conversation), spawn the concierge as a sub-agent instead:

```
Task(subagent_type: 'gentyr-concierge', prompt: "<the user's question>")
```

This works in both interactive (lockdown-on and lockdown-off) and spawned sessions — `gentyr-concierge` is on the `interactive-agent-guard.js` allowed-types whitelist as a read-only advisor.

Default to inline (Step 2). Use the sub-agent path only when context-isolation is a real benefit.

## Step 4 — Done

This is a one-shot command. Do NOT loop, do NOT poll, do NOT spawn anything beyond the optional Step-3 sub-agent. The concierge itself is also one-shot — it returns guidance and exits.

## Rules

- The concierge advises; the caller (you, or the user) acts. Do not execute write-side MCP tool calls on behalf of the user from this command.
- Every recommendation must include file:line citations so the user can verify against the docs.
- Quote 5–20 relevant lines max from any doc; never recite full content.
- If the question is ambiguous, state your assumption in the SUMMARY and answer the most likely interpretation. The user can re-run with clarification.
