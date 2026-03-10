#!/usr/bin/env node
/**
 * PreToolUse Hook: Block Team Agent Tools
 *
 * Hard-blocks Claude Code's built-in team agent tools (TeamCreate,
 * TeamDelete, SendMessage). These tools create worktrees that bypass
 * GENTYR's merge chain and cleanup lifecycle, causing lost work.
 *
 * No bypass mechanism — team tools are fundamentally incompatible
 * with GENTYR's agent spawning system.
 *
 * Location: .claude/hooks/block-team-tools.js
 * Auto-propagates to target projects via directory symlink (npm link model)
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision deny (hard block)
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 1.0.0
 */

const BLOCKED_TOOLS = new Set(['TeamCreate', 'TeamDelete', 'SendMessage']);

/**
 * Emit a hard deny response.
 */
function blockTool(toolName) {
  const reason = [
    `BLOCKED: \`${toolName}\` is not supported in GENTYR-managed projects.`,
    '',
    "Claude Code's built-in team tools create worktrees that bypass GENTYR's",
    'merge chain and cleanup lifecycle, causing lost work.',
    '',
    "Use GENTYR's agent spawning system instead:",
    '  1. Create tasks:  mcp__todo-db__create_task({ section, title, description, assigned_by, priority })',
    '  2. Spawn agents:  mcp__agent-tracker__force_spawn_tasks({ taskIds: [...] })',
    '  3. Monitor:       mcp__agent-tracker__monitor_agents({ agentIds: [...] })',
    '',
    'Or use the /spawn-tasks slash command for interactive spawning.',
  ].join('\n');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));

  console.error(`[block-team-tools] BLOCKED: ${toolName} is not supported in GENTYR-managed projects`);
  process.exit(0);
}

// Read JSON input from stdin
let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString();
});

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name;

    if (BLOCKED_TOOLS.has(toolName)) {
      blockTool(toolName);
      return;
    }

    // Not a blocked tool — allow
    process.exit(0);
  } catch (err) {
    // G001: fail-closed on parse errors — output deny JSON so Claude Code blocks the action
    console.error(`[block-team-tools] G001 FAIL-CLOSED: Error parsing input: ${err.message}`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `G001 FAIL-CLOSED: Hook error - ${err.message}`,
      },
    }));
    process.exit(0);
  }
});
