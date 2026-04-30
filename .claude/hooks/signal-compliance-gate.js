#!/usr/bin/env node
/**
 * Signal Compliance Gate — PreToolUse Hook
 *
 * Blocks complete_task and summarize_work when unacknowledged directive-tier
 * signals exist. Forces agents to acknowledge directives before completing.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AGENT_ID = process.env.CLAUDE_AGENT_ID;

// Fast exits
if (!AGENT_ID) {
  console.log(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
  // Interactive sessions are not gated
  console.log(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
}

async function main() {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let event;
  try {
    event = JSON.parse(rawInput);
  } catch {
    console.log(JSON.stringify({ decision: 'approve' }));
    return;
  }

  const toolName = event?.tool_name || '';

  // Only gate complete_task and summarize_work
  if (toolName !== 'mcp__todo-db__complete_task' && toolName !== 'mcp__todo-db__summarize_work') {
    console.log(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Check for unacknowledged directives
  try {
    // Resolve main project dir (worktrees read from main tree signal dir)
    const signalsModulePath = path.join(PROJECT_DIR, '.claude', 'hooks', 'lib', 'session-signals.js');
    if (!fs.existsSync(signalsModulePath)) {
      console.log(JSON.stringify({ decision: 'approve' }));
      return;
    }

    const mod = await import(signalsModulePath);
    const mainDir = mod.getMainProjectDir?.(PROJECT_DIR) || PROJECT_DIR;
    const directives = mod.getUnacknowledgedDirectives?.(AGENT_ID, mainDir) || [];

    if (directives.length > 0) {
      const ids = directives.map(d => d.id).join(', ');
      console.log(JSON.stringify({
        decision: 'block',
        reason: `BLOCKED: ${directives.length} unacknowledged directive(s) (${ids}). You MUST acknowledge all directives via mcp__agent-tracker__acknowledge_signal before completing your task. Call get_session_signals to see pending directives.`,
      }));
      return;
    }
  } catch {
    // Fail open — don't block completion if signal system is unavailable
  }

  console.log(JSON.stringify({ decision: 'approve' }));
}

main().catch(() => {
  console.log(JSON.stringify({ decision: 'approve' }));
});
