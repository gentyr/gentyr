#!/usr/bin/env node
/**
 * PostToolUse Hook: Release Artifact Collector
 *
 * Fires after mcp__todo-db__complete_task and mcp__todo-db__summarize_work.
 * When the session has a GENTYR_RELEASE_ID environment variable, archives
 * the session transcript to the release artifact directory.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const RELEASE_ID = process.env.GENTYR_RELEASE_ID || '';
const AGENT_ID = process.env.CLAUDE_AGENT_ID || '';
const NOOP = JSON.stringify({});

// Fast exit: only relevant for sessions participating in a release
if (!RELEASE_ID) {
  process.stdout.write(NOOP);
  process.exit(0);
}

const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'session-queue.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [release-artifact-collector] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // Non-fatal — log file not writable
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => { data += line; });
    rl.on('close', () => { resolve(data); });
    setTimeout(() => { rl.close(); resolve(data); }, 200);
  });
}

/**
 * Extract useful identifiers from the tool response.
 *
 * @param {object} input - Parsed hook input
 * @returns {{ sessionId: string|null, taskId: string|null, phase: string|null }}
 */
function extractResponseInfo(input) {
  let sessionId = null;
  let taskId = null;
  let phase = null;

  try {
    const response = input?.tool_response;
    let parsed = null;

    if (response && typeof response === 'object' && Array.isArray(response.content)) {
      // MCP content wrapper
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          try {
            parsed = JSON.parse(block.text);
            break;
          } catch (_) {
            // Not JSON text — skip
          }
        }
      }
    } else if (response && typeof response === 'object') {
      parsed = response;
    } else if (typeof response === 'string') {
      try {
        parsed = JSON.parse(response);
      } catch (_) {
        // Not JSON — skip
      }
    }

    if (parsed) {
      sessionId = parsed.session_id || parsed.sessionId || null;
      taskId = parsed.task_id || parsed.id || null;
      phase = parsed.phase || null;
    }
  } catch (err) {
    log(`Warning: failed to extract response info: ${err.message}`);
  }

  return { sessionId, taskId, phase };
}

async function main() {
  const stdinData = await readStdin();
  if (!stdinData) {
    process.stdout.write(NOOP);
    return;
  }

  let input;
  try {
    input = JSON.parse(stdinData);
  } catch (_) {
    process.stdout.write(NOOP);
    return;
  }

  // Extract session info from the tool response
  const { sessionId, taskId, phase } = extractResponseInfo(input);

  // Determine the session ID — use extracted or fall back to agent ID
  const effectiveSessionId = sessionId || AGENT_ID || 'unknown';
  const effectivePhase = phase || 'unclassified';

  // Import and call the artifact collector
  try {
    const { collectSessionArtifact } = await import('./lib/release-orchestrator.js');

    const result = collectSessionArtifact(
      RELEASE_ID,
      effectiveSessionId,
      AGENT_ID,
      effectivePhase,
      PROJECT_DIR
    );

    if (result.copied) {
      log(`Archived session transcript for release ${RELEASE_ID}: ${result.targetPath}`);
    } else {
      log(`Could not archive session for release ${RELEASE_ID} (agent: ${AGENT_ID})`);
    }
  } catch (err) {
    log(`Warning: artifact collection failed: ${err.message}`);
    // Non-fatal — never crash the hook
  }

  process.stdout.write(NOOP);
}

main().catch((err) => {
  // Non-fatal — PostToolUse hooks must always exit 0
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      path.join(PROJECT_DIR, '.claude', 'session-queue.log'),
      `[${timestamp}] [release-artifact-collector] Unhandled error: ${err.message}\n`
    );
  } catch (_) {
    // Absolutely non-fatal
  }
  process.stdout.write(NOOP);
});
