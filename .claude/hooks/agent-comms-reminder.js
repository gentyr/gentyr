#!/usr/bin/env node
/**
 * PostToolUse Hook: Agent Communications Reminder
 *
 * Fires every ~10 tool calls for spawned sessions only. Reminds spawned agents
 * to check what other agents are working on and to coordinate via signals.
 *
 * Uses a per-agent counter file to track tool call frequency.
 *
 * Input: JSON on stdin from Claude Code PostToolUse event
 * Output: JSON on stdout with continue + optional additionalContext
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');

const REMINDER_INTERVAL = 10; // Every N tool calls

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Read stdin (required for PostToolUse hooks)
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Only fires for spawned sessions
  if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  const agentId = process.env.CLAUDE_AGENT_ID;
  if (!agentId) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Read counter
  const counterFile = path.join(STATE_DIR, `comms-reminder-${agentId}.count`);
  let counter = 0;

  try {
    if (fs.existsSync(counterFile)) {
      const raw = fs.readFileSync(counterFile, 'utf8').trim();
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) {
        counter = parsed;
      }
    }
  } catch (err) {
    console.error('[agent-comms-reminder] Counter read error:', err.message);
    // Non-fatal: start from 0
  }

  // Increment counter
  counter++;

  // Write back
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(counterFile, String(counter));
  } catch (err) {
    console.error('[agent-comms-reminder] Counter write error:', err.message);
    // Non-fatal
  }

  // Only inject reminder every REMINDER_INTERVAL tool calls
  if (counter % REMINDER_INTERVAL !== 0) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  const reminderMessage = [
    '[COORDINATION REMINDER] You should periodically check what other agents are',
    'working on. Use mcp__agent-tracker__get_session_queue_status to see running',
    'sessions. If your work affects other running agents, send them a note:',
    'mcp__agent-tracker__send_session_signal({ target: "<agent_id>", tier: "note", message: "..." })',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: reminderMessage,
    },
  }));
}

main().catch((err) => {
  console.error('[agent-comms-reminder] Unhandled error:', err.message);
  process.stdout.write(JSON.stringify({ continue: true }));
});
