#!/usr/bin/env node
/**
 * PostToolUse Hook: Signal Reader
 *
 * Fires on every tool call for spawned sessions. Checks for unread inter-agent
 * signals and injects them into the model's context via additionalContext.
 *
 * Must be extremely fast on the happy path (no signals) — only reads the
 * signal directory listing, not file contents, when count is zero.
 *
 * Three signal tiers:
 *   note        — FYI only, informational
 *   instruction — Deputy-CTO urgent instruction, must acknowledge
 *   directive   — CTO mandatory override, address immediately
 *
 * Input: JSON on stdin from Claude Code PostToolUse event
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

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Read stdin (required for PostToolUse hooks)
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Only fires for spawned sessions — interactive CTO sessions skip
  const agentId = process.env.CLAUDE_AGENT_ID;
  if (!agentId) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Dynamically import session-signals to get the current PROJECT_DIR
  const signalsModulePath = path.join(__dirname, 'lib', 'session-signals.js');
  if (!fs.existsSync(signalsModulePath)) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  let getUnreadCount, readPendingSignals;
  try {
    const signals = await import(signalsModulePath);
    getUnreadCount = signals.getUnreadCount;
    readPendingSignals = signals.readPendingSignals;
  } catch (err) {
    console.error('[signal-reader] Failed to import session-signals:', err.message);
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Fast path: check count before reading any file contents
  let unreadCount;
  try {
    unreadCount = getUnreadCount(agentId, PROJECT_DIR);
  } catch (err) {
    console.error('[signal-reader] getUnreadCount error:', err.message);
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  if (unreadCount === 0) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Read and mark signals as read
  let signals;
  try {
    signals = readPendingSignals(agentId, PROJECT_DIR);
  } catch (err) {
    console.error('[signal-reader] readPendingSignals error:', err.message);
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  if (!signals || signals.length === 0) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Format signals by tier
  const formattedParts = signals.map(sig => formatSignal(sig, agentId));
  const additionalContext = formattedParts.join('\n\n---\n\n');

  process.stdout.write(JSON.stringify({
    decision: 'approve',
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  }));
}

/**
 * Format a single signal for injection into model context.
 * @param {object} sig - Signal object
 * @param {string} agentId - The receiving agent's ID
 * @returns {string}
 */
function formatSignal(sig, agentId) {
  switch (sig.tier) {
    case 'note':
      return [
        '[AGENT COMMUNICATION — HELPFUL NOTE]',
        `From: ${sig.from_agent_type} agent working on "${sig.from_task_title}"`,
        'Task context: You are working on your assigned task. This note is FYI only.',
        '',
        `Message: "${sig.message}"`,
        '',
        'This is informational. Use your judgment on whether it affects your work.',
        `To review more: mcp__agent-tracker__get_session_signals({ agent_id: "${agentId}" })`,
      ].join('\n');

    case 'instruction':
      return [
        '[DEPUTY-CTO INSTRUCTION — URGENT]',
        'The Deputy-CTO has sent you an instruction. You MUST acknowledge and adhere to it.',
        '',
        `Message: "${sig.message}"`,
        '',
        `Acknowledge with: mcp__agent-tracker__acknowledge_signal({ signal_id: "${sig.id}" })`,
      ].join('\n');

    case 'directive':
      return [
        '[CTO DIRECTIVE — MANDATORY OVERRIDE]',
        'The CTO has issued a direct directive via the Deputy-CTO. This OVERRIDES your',
        'current approach. Address this IMMEDIATELY before any other work.',
        '',
        `Message: "${sig.message}"`,
        '',
        `Acknowledge with: mcp__agent-tracker__acknowledge_signal({ signal_id: "${sig.id}" })`,
      ].join('\n');

    default:
      return [
        `[AGENT COMMUNICATION — ${sig.tier.toUpperCase()}]`,
        `From: ${sig.from_agent_type} (${sig.from_agent_id})`,
        '',
        `Message: "${sig.message}"`,
      ].join('\n');
  }
}

main().catch((err) => {
  console.error('[signal-reader] Unhandled error:', err.message);
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
});
