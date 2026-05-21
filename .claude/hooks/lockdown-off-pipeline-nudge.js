#!/usr/bin/env node
/**
 * PostToolUse Hook: Lockdown-Off Orchestration Nudge
 *
 * When lockdown is DISABLED in an interactive CTO session and the CTO uses
 * the Task/Agent tool directly to spawn a code-modifying sub-agent, fire a
 * one-time-per-session reminder pointing to the GENTYR orchestration systems
 * (/spawn-tasks, /persistent-task, /plan).
 *
 * Rationale: direct Task/Agent calls bypass tracking (todo.db / persistent-tasks.db
 * / plans.db), audit gates, crash recovery, and progress monitoring. The
 * orchestration systems give all of that AND automatically run the standard
 * 6-step pipeline.
 *
 * Fast-exit paths:
 *  - Spawned sessions (CLAUDE_SPAWNED_SESSION === 'true')
 *  - Lockdown is ON (interactiveLockdownDisabled !== true)
 *  - Tool is not Task/Agent
 *  - Sub-agent type is not code-modifying
 *  - Already fired for this session UUID
 *
 * Non-blocking: emits hookSpecificOutput.additionalContext only. Never denies.
 *
 * State file: .claude/state/lockdown-off-nudge.json — keyed by session UUID.
 *
 * SECURITY: This file should be root-owned via npx gentyr protect (added to
 * criticalHooks in cli/commands/protect.js).
 *
 * @version 1.1.0
 */

import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const CODE_MODIFYING_AGENTS = new Set([
  'code-writer', 'test-writer', 'code-reviewer', 'demo-manager',
]);

function fastExit() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

async function main() {
  // Read event input
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    fastExit();
    return;
  }

  // Fast-exit: spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') return fastExit();

  // Fast-exit: only fire on Task/Agent
  const toolName = event?.tool_name || '';
  if (toolName !== 'Task' && toolName !== 'Agent') return fastExit();

  // Fast-exit: only nudge for code-modifying sub-agents
  const subagentType = event?.tool_input?.subagent_type || event?.tool_input?.subagentType || '';
  if (!CODE_MODIFYING_AGENTS.has(subagentType)) return fastExit();

  // Fast-exit: lockdown ON (default)
  const configPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
  let lockdownOff = false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    lockdownOff = config.interactiveLockdownDisabled === true;
  } catch { /* lockdown is on (default) */ }
  if (!lockdownOff) return fastExit();

  // Fast-exit: no session UUID — can't dedup
  const sessionId = event?.session_id || event?.sessionId || '';
  if (!sessionId) return fastExit();

  // Check per-session state file (dedup — fire once per session)
  const stateDir = path.join(PROJECT_DIR, '.claude', 'state');
  const statePath = path.join(stateDir, 'lockdown-off-nudge.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch { /* fresh state */ }

  if (state[sessionId]) return fastExit();

  // Mark fired
  state[sessionId] = { firedAt: new Date().toISOString(), tool: toolName, subagentType };
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  } catch { /* non-fatal */ }

  // Emit the nudge
  const additionalContext = [
    '[LOCKDOWN OFF — orchestration nudge]',
    '',
    `You just spawned '${subagentType}' directly via ${toolName}. That works, but it bypasses GENTYR orchestration:`,
    '  - Not tracked in todo.db / persistent-tasks.db / plans.db',
    '  - No audit gate verifies the result',
    '  - No crash recovery if the session dies',
    '  - Invisible to /monitor, /status, and the CTO dashboard',
    '',
    'For future code work in this session, prefer:',
    '  /spawn-tasks <description>   — one-shot work; runs the full 6-step pipeline in a fresh worktree',
    '  /persistent-task             — multi-session objective with a monitor that orchestrates sub-tasks',
    '  /plan                        — multi-phase plan with phases, gates, and a plan-manager',
    '',
    'The 6-step pipeline (investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager) runs automatically inside those systems.',
    '',
    'This reminder fires once per session.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  }));
}

main().catch(() => fastExit());
