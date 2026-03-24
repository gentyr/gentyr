#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Communications Notifier
 *
 * Fires on every CTO prompt in interactive sessions. Checks for new inter-agent
 * communications since the last check and injects a summary into the model context.
 *
 * Only runs for interactive (non-spawned) sessions. Spawned sessions use the
 * signal-reader.js PostToolUse hook instead.
 *
 * Input: JSON on stdin from Claude Code UserPromptSubmit event
 * Output: JSON on stdout with continue + optional additionalContext
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const LAST_CHECK_FILE = path.join(STATE_DIR, 'comms-notifier-last-check.json');

// ============================================================================
// State Management
// ============================================================================

function readLastCheck() {
  try {
    if (fs.existsSync(LAST_CHECK_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf8'));
      return data.last_check || null;
    }
  } catch (err) {
    console.error('[comms-notifier] readLastCheck error:', err.message);
  }
  return null;
}

function writeLastCheck(timestamp) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify({ last_check: timestamp }, null, 2) + '\n');
  } catch (err) {
    console.error('[comms-notifier] writeLastCheck error:', err.message);
    // Non-fatal
  }
}

// ============================================================================
// Time Formatting
// ============================================================================

function formatTimeAgo(isoTimestamp) {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Only for interactive (non-spawned) sessions
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Import session-signals module
  const signalsModulePath = path.join(__dirname, 'lib', 'session-signals.js');
  if (!fs.existsSync(signalsModulePath)) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  let getSignalLog;
  try {
    const signals = await import(signalsModulePath);
    getSignalLog = signals.getSignalLog;
  } catch (err) {
    console.error('[comms-notifier] Failed to import session-signals:', err.message);
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  const now = new Date().toISOString();
  const lastCheck = readLastCheck();

  // Update last check timestamp before reading (ensures we always advance)
  writeLastCheck(now);

  // Get new comms since last check
  let newComms;
  try {
    newComms = getSignalLog({ since: lastCheck || undefined, projectDir: PROJECT_DIR });
  } catch (err) {
    console.error('[comms-notifier] getSignalLog error:', err.message);
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  if (!newComms || newComms.length === 0) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Build summary
  const lines = [
    `[NEW AGENT COMMUNICATIONS]`,
    `${newComms.length} new inter-agent communication${newComms.length !== 1 ? 's' : ''} since your last prompt:`,
    '',
  ];

  newComms.forEach((comm, i) => {
    const preview = comm.message ? comm.message.substring(0, 80) + (comm.message.length > 80 ? '...' : '') : '';
    const timeAgo = comm.ts ? formatTimeAgo(comm.ts) : 'unknown time';
    lines.push(
      `${i + 1}. [${(comm.tier || 'unknown').toUpperCase()}] ${comm.from_agent_type || 'unknown'} → ${comm.to_agent_type || 'unknown'}: "${preview}"`,
      `   (${timeAgo}) — mcp__agent-tracker__get_comms_log for full details`,
    );
  });

  lines.push(
    '',
    'As deputy-CTO, review these and inform the CTO if any are significant.',
    `Use mcp__agent-tracker__get_comms_log({ since: "${lastCheck || ''}", limit: 10 }) for details.`,
  );

  const additionalContext = lines.join('\n');

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

main().catch((err) => {
  console.error('[comms-notifier] Unhandled error:', err.message);
  process.stdout.write(JSON.stringify({ continue: true }));
});
