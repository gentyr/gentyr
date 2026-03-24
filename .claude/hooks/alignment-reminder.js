#!/usr/bin/env node
/**
 * PostToolUse Hook: Alignment Reminder
 *
 * For spawned sessions only. Fires every ~20 tool calls to remind the agent
 * to run the user-alignment sub-agent before submitting work.
 *
 * Counter is persisted per-agent in .claude/state/alignment-reminder-<agentId>.count
 * so it survives across tool calls within the same session.
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

const TRIGGER_EVERY = 20; // Fire reminder every N tool calls

async function main() {
  // Read and discard stdin (required for PostToolUse hooks)
  await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on('close', resolve);
    rl.resume();
    setTimeout(() => { rl.close(); resolve(); }, 100);
  });

  // Only applies to spawned (automated) sessions
  if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const AGENT_ID = process.env.CLAUDE_AGENT_ID || 'unknown';
  const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
  const COUNTER_FILE = path.join(STATE_DIR, `alignment-reminder-${AGENT_ID}.count`);

  // Read counter
  let counter = 0;
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const raw = fs.readFileSync(COUNTER_FILE, 'utf8').trim();
      counter = parseInt(raw, 10) || 0;
    }
  } catch (_) {
    // Non-fatal — start at 0
  }

  // Increment and persist
  counter += 1;
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(COUNTER_FILE, String(counter), 'utf8');
  } catch (_) {
    // Non-fatal
  }

  // Only inject every TRIGGER_EVERY calls
  if (counter % TRIGGER_EVERY !== 0) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const reminder = [
    `[ALIGNMENT REMINDER] Before submitting your work, you MUST run the user-alignment`,
    `sub-agent. The alignment agent is the respected authority on whether your work meets`,
    `CTO intent. You must also spawn the project-manager for git operations.`,
    ``,
    `Required completion sequence:`,
    `  user-alignment \u2192 project-manager \u2192 verify merge \u2192 user-alignment (final) \u2192 summarize_work`,
  ].join('\n');

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: reminder,
    },
  }));

  process.exit(0);
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
