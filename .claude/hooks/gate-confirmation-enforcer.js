#!/usr/bin/env node
/**
 * PostToolUse Hook: Gate Confirmation Enforcer
 *
 * Fires after mcp__todo-db__create_task and
 * mcp__persistent-task__create_persistent_task. When the response contains
 * gate_status: 'draft', injects a mandatory reminder via additionalContext
 * instructing the agent to run a user-alignment review then confirm the gate.
 *
 * Only fires for spawned sessions — interactive (CTO) sessions can confirm
 * gates directly without the two-step flow.
 *
 * Fast: no database reads, just parses the tool response JSON.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', (l) => { data += l; });
rl.on('close', () => {
  try {
    // Fast-exit for interactive sessions — only spawned agents need the reminder
    if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const hookInput = JSON.parse(data);

    // Parse the tool response into a plain object.
    // Claude Code passes tool_response in several formats:
    //   1. Bare array: [{ type: 'text', text: JSON.stringify(result) }]
    //   2. MCP content wrapper: { content: [{ type: 'text', text: '...' }] }
    //   3. Plain object: { gate_status: 'draft', ... }
    //   4. JSON string: '{"gate_status":"draft",...}'
    const responseData = parseToolResponse(hookInput.tool_response);

    if (!responseData) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Fast-exit if gate_status is not 'draft'
    if (responseData.gate_status !== 'draft') {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Determine whether this was a todo-db task or persistent task
    const toolName = hookInput.tool_name || '';
    const isPersistentTask = toolName.includes('persistent');

    const title = responseData.title || responseData.name || '(unknown)';
    const confirmTool = isPersistentTask ? 'confirm_pt_gate' : 'confirm_task_gate';

    const ctx = [
      '[AUDIT GATE \u2014 MANDATORY TWO-STEP FLOW]',
      '',
      'You created a task with a DRAFT gate. The task CANNOT be spawned until confirmed.',
      '',
      'Step 1: Spawn a user-alignment sub-agent to review your gate criteria against user prompts:',
      `  Task(subagent_type='user-alignment', prompt='Review gate definition against user prompts. Task: ${title}. Criteria: <CRITERIA>. Method: <METHOD>. Search for relevant CTO prompts and confirm or refine the gate.')`,
      '',
      `Step 2: Call ${confirmTool} (${isPersistentTask ? 'for persistent tasks' : 'or confirm_pt_gate for persistent tasks'}) with any refined criteria.`,
      '',
      'EXEMPTION: Gate-exempt categories (triage, project-management, workstream-management) may call confirm_*_gate immediately without user-alignment review.',
    ].join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: ctx,
      },
    }));
    process.exit(0);
  } catch {
    // PostToolUse hooks must never block — non-fatal on any parse/runtime error
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});

// Safety timeout in case stdin never closes
setTimeout(() => {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}, 4000);

/**
 * Parse the MCP tool response into a plain object.
 *
 * Handles all known response formats from Claude Code:
 *   1. Bare content array: [{ type: 'text', text: '...' }]
 *   2. MCP content wrapper: { content: [{ type: 'text', text: '...' }] }
 *   3. JSON string: '{"gate_status":"draft",...}'
 *   4. Plain object: { gate_status: 'draft', ... }
 *
 * Returns null if parsing fails in all formats.
 */
function parseToolResponse(toolResponse) {
  if (!toolResponse) return null;

  // Format 1: Bare content array — Claude Code's primary format
  if (Array.isArray(toolResponse)) {
    for (const block of toolResponse) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          return JSON.parse(block.text);
        } catch {
          // Try next block
        }
      }
    }
    return null;
  }

  // Format 2: MCP content wrapper — { content: [...] }
  if (typeof toolResponse === 'object' && Array.isArray(toolResponse.content)) {
    for (const block of toolResponse.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          return JSON.parse(block.text);
        } catch {
          // Try next block
        }
      }
    }
    return null;
  }

  // Format 3: JSON string
  if (typeof toolResponse === 'string') {
    try {
      return JSON.parse(toolResponse);
    } catch {
      return null;
    }
  }

  // Format 4: Plain object — already deserialized
  if (typeof toolResponse === 'object') {
    return toolResponse;
  }

  return null;
}
