#!/usr/bin/env node
/**
 * PreToolUse Hook: Debate Mode Guard
 *
 * Enforces the `/debate on` / `/debate off` toggle by denying any Agent /
 * Task tool call that tries to spawn an investigator sub-agent carrying a
 * `DEBATE_ROLE: defender|challenger|judge` marker when debate mode is off.
 *
 * This is the enforcement layer of a three-layer pattern (Guidance +
 * Orchestration + Enforcement, per GENTYR's enforcement doctrine in
 * CLAUDE.md). The agent's prompt instructions and the session briefing
 * notice are advisory; THIS hook is the ground truth — the investigator
 * literally cannot spawn debate sub-agents when the toggle is off.
 *
 * State file: .claude/state/debate-mode.json
 *   { "enabled": boolean, "setAt": ISO, "setBy": string }
 *
 * Default when file is absent: enabled (debate runs on non-trivial
 * investigations). Toggled via the `set_debate_mode` MCP tool on the
 * agent-tracker server, or via the `/debate` slash command.
 *
 * Fail-open: any read error (missing dir, corrupt JSON, permission denied)
 * is treated as "enabled". This is a productivity toggle, not a security
 * boundary, so a fail-open posture avoids breaking debate due to file-
 * system issues.
 *
 * Hot path: when tool_name is not Agent/Task, or subagent_type is not
 * 'investigator', or the prompt doesn't contain `DEBATE_ROLE:`, the hook
 * exits in under 1ms without touching disk.
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file is added to criticalHooks in cli/commands/protect.js
 * so it's root-owned when `npx gentyr protect` has been run — spawned
 * agents cannot modify or delete it.
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'debate-mode.json');

// Same regex shape as findDebateRole() in .claude/hooks/lib/jsonl-usage-parser.js
// — anchored to a line start (^ or after a literal newline) so substring
// matches in body text don't trip the guard. The JSONL-escape variant
// (`\\n`) isn't relevant here because we're matching against the raw prompt
// argument as passed to the Task tool, not against JSONL serialization.
const DEBATE_MARKER_RE = /(?:^|\n)DEBATE_ROLE:\s*(defender|challenger|judge)\b/;

function isDebateEnabled() {
  try {
    if (!fs.existsSync(STATE_PATH)) return true;  // default: enabled
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return raw.enabled !== false;  // any non-false value -> enabled
  } catch {
    return true;  // fail-open on any read/parse error
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Fast-exit: not an Agent/Task call.
  const toolName = event?.tool_name || '';
  if (toolName !== 'Agent' && toolName !== 'Task') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Fast-exit: not an investigator sub-agent spawn.
  const subagentType = event?.tool_input?.subagent_type || '';
  if (subagentType !== 'investigator') {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // Fast-exit: prompt doesn't contain a DEBATE_ROLE marker.
  const prompt = event?.tool_input?.prompt || '';
  const match = typeof prompt === 'string' ? prompt.match(DEBATE_MARKER_RE) : null;
  if (!match) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  // We have a debate Task call. Read state and decide.
  if (isDebateEnabled()) {
    process.stdout.write(JSON.stringify({ allow: true }));
    return;
  }

  const role = match[1];
  const reason = [
    `BLOCKED: Debate mode is DISABLED. Cannot spawn investigator sub-agent with DEBATE_ROLE: ${role}.`,
    '',
    'The investigator\'s adversarial-debate flow (defender + challenger + judge) is currently',
    'turned off project-wide. State file: .claude/state/debate-mode.json',
    '',
    'For the investigator agent: skip steps 14-16 of the Investigation Workflow and proceed',
    'directly to step 17 (Log Solutions) with the initial plan from step 12. Note in the final',
    'report that the debate flow is currently disabled.',
    '',
    'To re-enable: an interactive CTO session can run /debate on, or call',
    'mcp__agent-tracker__set_debate_mode({ enabled: true }). Takes effect on the next Task spawn.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  }));
}

main().catch(() => {
  // Fail-open on any unexpected error — debate mode is a productivity
  // toggle, not a security boundary, so we never block a legitimate
  // Task call because of a hook bug.
  process.stdout.write(JSON.stringify({ allow: true }));
});
