#!/usr/bin/env node
/**
 * PreToolUse Hook: Interactive Session Lockdown Guard
 *
 * Enforces the deputy-CTO console model: in interactive (non-spawned) sessions,
 * only read/observe tools are allowed. File-editing tools (Edit, Write, etc.)
 * and sub-agent spawning tools (Agent, Task) are blocked.
 *
 * This transforms the interactive Claude Code session into a read-only
 * "deputy-CTO console" where Claude manages the engineering team through
 * GENTYR's task and agent system rather than editing files directly.
 *
 * Bypass: set `interactiveLockdownDisabled: true` in automation-config.json.
 * This is intended for development/debugging only — a warning is injected
 * into the AI model's context when lockdown is disabled.
 *
 * Spawned sessions (`CLAUDE_SPAWNED_SESSION=true`) are always unrestricted —
 * they need full tool access to do their work.
 *
 * Location: .claude/hooks/interactive-lockdown-guard.js
 * Auto-propagates to target projects via directory symlink (npm link model)
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Tools allowed in interactive (deputy-CTO console) sessions.
 *
 * These are read/observe/query tools that the deputy-CTO needs to:
 * - Read code and documentation (Read, Glob, Grep)
 * - Run read-only shell commands — git log, gh pr list, etc. (Bash)
 * - Fetch external URLs for reference (WebFetch, WebSearch)
 * - Ask the CTO clarifying questions (AskUserQuestion)
 * - Invoke slash commands and search tool schemas (Skill, ToolSearch)
 *
 * Everything NOT in this set is blocked for interactive sessions.
 * MCP tools (mcp__*) are handled separately — they are always allowed
 * since they have their own access controls (protected-action-gate.js).
 */
const ALLOWED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'Skill',
  'ToolSearch',
]);

/**
 * Read automation-config.json to check if lockdown is disabled.
 * Returns false (lockdown enabled) if the file cannot be read.
 * @returns {boolean}
 */
function isLockdownDisabled() {
  try {
    const configPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    return config.interactiveLockdownDisabled === true;
  } catch {
    // File missing or unparseable — lockdown is ENABLED by default (fail-closed)
    return false;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    // G001: fail-closed on parse errors
    process.stderr.write(`[interactive-lockdown-guard] G001 FAIL-CLOSED: Failed to parse input: ${err.message}\n`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `G001 FAIL-CLOSED: Hook error — ${err.message}`,
      },
    }));
    return;
  }

  const toolName = event?.tool_name || '';

  // Happy path: spawned sessions bypass the lockdown immediately (< 1ms)
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // Check lockdown disabled flag (interactive sessions only)
  if (isLockdownDisabled()) {
    const warning = '[LOCKDOWN DISABLED] The deputy-CTO lockdown is currently disabled. You have full tool access. Remember to re-enable via /lockdown on for proper GENTYR workflow.';
    process.stdout.write(JSON.stringify({
      decision: 'allow',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: warning,
      },
    }));
    return;
  }

  // MCP tools are always allowed — they have their own access controls
  if (toolName.startsWith('mcp__')) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // Allowed tools pass through
  if (ALLOWED_TOOLS.has(toolName)) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  // Block everything else
  const reason = [
    `Deputy-CTO console: \`${toolName}\` is not available in interactive mode.`,
    '',
    'In interactive sessions, you are the Deputy-CTO. You manage the engineering',
    'team through GENTYR\'s task and agent system — you do not edit files directly.',
    '',
    'To make code changes, create a task and spawn an agent:',
    '  1. mcp__todo-db__create_task({ section: \'CODE-REVIEWER\', title: \'...\', description: \'...\', assigned_by: \'cto\' })',
    '  2. mcp__agent-tracker__force_spawn_tasks({ taskIds: [\'...\'] })',
    '  3. mcp__agent-tracker__monitor_agents({ agentIds: [\'...\'] })',
    '',
    'Or use /spawn-tasks for interactive task creation and spawning.',
    '',
    'To disable this lockdown temporarily (development only):',
    '  /lockdown off',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

main().catch((err) => {
  // G001: fail-closed on unexpected errors
  process.stderr.write(`[interactive-lockdown-guard] G001 FAIL-CLOSED: Unexpected error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `G001 FAIL-CLOSED: Hook error — ${err.message}`,
    },
  }));
});
