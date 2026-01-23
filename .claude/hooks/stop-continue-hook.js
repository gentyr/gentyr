#!/usr/bin/env node

/**
 * Stop Hook - Auto-continue for automated [Task] sessions
 *
 * This hook forces one continuation cycle for spawned sessions that begin with "[Task]".
 * It checks:
 * 1. Was the initial prompt tagged with "[Task]"? (automated session)
 * 2. Is stop_hook_active false? (first stop, not already continuing)
 *
 * If both true, it blocks the stop and asks Claude to continue if more work remains.
 * Otherwise, it allows the stop.
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

// Debug logging - writes to file since stdout is used for hook response
const DEBUG = true;
const DEBUG_LOG_PATH = path.join(process.cwd(), '.claude', 'hooks', 'stop-hook-debug.log');

function debugLog(message, data = null) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] ${message}`;
  if (data !== null) {
    logLine += '\n' + JSON.stringify(data, null, 2);
  }
  logLine += '\n---\n';
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, logLine);
  } catch (err) {
    // Ignore write errors
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    // Timeout after 100ms if no data
    setTimeout(() => { rl.close(); resolve(data); }, 100);
  });
}

async function main() {
  debugLog('Stop hook triggered');

  try {
    const stdinData = await readStdin();

    debugLog('Raw stdin data', stdinData ? stdinData.substring(0, 2000) : '(empty)');

    if (!stdinData) {
      // No input, allow stop
      debugLog('No stdin data, allowing stop');
      console.log(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    const input = JSON.parse(stdinData);

    debugLog('Parsed input keys', Object.keys(input));
    debugLog('Full input structure', input);

    // Check if this is an automated [Task] session
    // The initial prompt should be in the conversation history
    const isTaskSession = checkIfTaskSession(input);

    // Check if we're already in a continuation cycle
    const alreadyContinuing = input.stop_hook_active === true;

    debugLog('Decision factors', {
      isTaskSession,
      alreadyContinuing,
      stop_hook_active: input.stop_hook_active,
      CLAUDE_SPAWNED_SESSION: process.env.CLAUDE_SPAWNED_SESSION
    });

    if (isTaskSession && !alreadyContinuing) {
      // First stop of a [Task] session - force one continuation
      debugLog('Decision: BLOCK (first stop of [Task] session)');
      console.log(JSON.stringify({
        decision: 'block',
        reason: 'If there is more work to investigate or resolve related to the initial [Task] request, continue working. Otherwise, you may stop.'
      }));
    } else {
      // Either not a [Task] session, or already continued once - allow stop
      debugLog('Decision: APPROVE', { reason: isTaskSession ? 'already continued once' : 'not a [Task] session' });
      console.log(JSON.stringify({ decision: 'approve' }));
    }

    process.exit(0);
  } catch (err) {
    // On error, allow stop (fail open)
    debugLog('Error in hook', { error: err.message, stack: err.stack });
    console.error(`Stop hook error: ${err.message}`);
    console.log(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }
}

/**
 * Check if this session started with a [Task] prefix
 * @param {object} input - Hook input containing conversation context
 * @returns {boolean}
 */
function checkIfTaskSession(input) {
  // The Stop hook only receives: session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active
  // We need to read the transcript file to find the initial prompt

  // 1. Read transcript file to find first user message
  if (input.transcript_path) {
    debugLog('Reading transcript file', input.transcript_path);
    try {
      const transcriptContent = fs.readFileSync(input.transcript_path, 'utf8');
      const lines = transcriptContent.split('\n').filter(line => line.trim());

      // JSONL format - each line is a JSON object
      for (const line of lines.slice(0, 10)) { // Check first 10 lines
        try {
          const entry = JSON.parse(line);

          // Look for human/user message type
          if (entry.type === 'human' || entry.type === 'user') {
            const content = entry.message?.content || entry.content || '';
            debugLog('Found user message', content.substring(0, 300));

            if (content.startsWith('[Task]')) {
              debugLog('[Task] found in transcript first user message');
              return true;
            }
            // Only check first user message
            break;
          }
        } catch (parseErr) {
          // Skip malformed lines
          continue;
        }
      }
    } catch (err) {
      debugLog('Error reading transcript', { error: err.message });
    }
  }

  // 2. Fallback: Check for CLAUDE_SPAWNED_SESSION env var
  // This is set by hooks when spawning background agents
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    debugLog('[Task] detected via CLAUDE_SPAWNED_SESSION env var');
    return true;
  }

  debugLog('No [Task] marker found');
  return false;
}

main();
