#!/usr/bin/env node
/**
 * PreToolUse Hook: Interactive Agent Guard
 *
 * Blocks code-modifying Agent tool calls in interactive (non-spawned) sessions.
 * Claude Code's built-in Agent tool creates worktrees WITHOUT GENTYR provisioning
 * (no hooks, no MCP config, no guards), and processes results by switching
 * branches in the main tree. Forces CTO to use GENTYR's task system instead.
 *
 * Read-only agent types (Explore, Plan, claude-code-guide, statusline-setup)
 * are allowed for quick research. Spawned (automated) sessions are unaffected.
 *
 * Uses Claude Code's permissionDecision JSON output for hard blocking.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 1.0.0
 */

// Whitelist of agent types allowed in interactive sessions (read-only)
// Structurally read-only: tools exclude Edit/Write/NotebookEdit
// Behaviorally read-only: investigator (CLAUDE.md), user-alignment (agent def)
const ALLOWED_INTERACTIVE_TYPES = new Set([
  'Explore',
  'Plan',
  'claude-code-guide',
  'deputy-cto',
  'feedback-agent',
  'investigator',
  'product-manager',
  'repo-hygiene-expert',
  'secret-manager',
  'statusline-setup',
  'user-alignment',
]);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    // Invalid JSON — allow (fail-open)
    console.error(`[interactive-agent-guard] ERROR: Failed to parse input: ${err.message}`);
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Only handle Agent tool calls
  const toolName = event?.tool_name || '';
  if (toolName !== 'Agent') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Spawned (automated) sessions always allowed — they need Agent for sub-agent work
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Interactive monitor sessions need Agent/Task for sub-agent orchestration
  if (process.env.GENTYR_INTERACTIVE_MONITOR === 'true') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Extract subagent_type (defaults to 'general-purpose' if omitted)
  const subagentType = event?.tool_input?.subagent_type || 'general-purpose';

  // Read-only agent types are allowed in interactive sessions
  if (ALLOWED_INTERACTIVE_TYPES.has(subagentType)) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Block code-modifying agent types
  const allowedList = [...ALLOWED_INTERACTIVE_TYPES].join(', ');
  const reason = [
    `BLOCKED: Agent type '${subagentType}' not allowed in interactive sessions.`,
    '',
    'GENTYR manages agent isolation, worktree provisioning, and lifecycle.',
    "Claude Code's built-in Agent tool creates worktrees WITHOUT GENTYR provisioning",
    '(no hooks, no MCP config, no guards) and causes branch switching in the main tree.',
    '',
    'Use the GENTYR task system instead:',
    '  /spawn-tasks <description>     — create and spawn tasks from plain English',
    '  /spawn-tasks                   — browse and spawn pending tasks',
    '  create_task + force_spawn_tasks — programmatic MCP tools',
    '',
    `Allowed interactive agent types (read-only): ${allowedList}`,
  ].join('\n');

  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  }));
}

main().catch((err) => {
  // Fail-open on unexpected errors
  console.error(`[interactive-agent-guard] ERROR: ${err.message}`);
  process.stdout.write(JSON.stringify({ allow: true }));
});
