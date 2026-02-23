#!/usr/bin/env node

/**
 * Stop Hook - Auto-continue for automated [Task] sessions + quota death detection
 *
 * This hook forces one continuation cycle for spawned sessions that begin with "[Task]".
 * It checks:
 * 1. Was the initial prompt tagged with "[Task]"? (automated session)
 * 2. Is the session dying from a quota/rate limit? (detect and record for revival)
 * 3. Is stop_hook_active false? (first stop, not already continuing)
 *
 * Quota detection: If the last JSONL entries show error:"rate_limit" + isApiErrorMessage,
 * the hook writes recovery state and approves the stop immediately (instead of wasting
 * the one remaining API call on a doomed retry). The session-reviver picks up later.
 *
 * It also attempts credential rotation when quota is hit, so the next retry (if any)
 * or the revived session will use fresh credentials.
 */

import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import {
  readRotationState,
  writeRotationState,
  logRotationEvent,
  updateActiveCredentials,
  checkKeyHealth,
  selectActiveKey,
  refreshExpiredToken,
} from './key-sync.js';

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

const STATE_DIR = path.join(process.cwd(), '.claude', 'state');
const QUOTA_INTERRUPTED_PATH = path.join(STATE_DIR, 'quota-interrupted-sessions.json');
const TAIL_BYTES = 8192;

/**
 * Read the last N bytes of a file (seek to end, no full-file read).
 */
function readTail(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - numBytes);
    const buf = Buffer.alloc(Math.min(numBytes, stat.size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Check if the session is dying from a quota/rate limit by examining recent JSONL entries.
 * Returns { isQuotaDeath: boolean, quotaMessage?: string }
 */
function detectQuotaDeath(transcriptPath) {
  if (!transcriptPath) return { isQuotaDeath: false };

  const tail = readTail(transcriptPath, TAIL_BYTES);
  if (!tail) return { isQuotaDeath: false };

  const lines = tail.split('\n').filter(l => l.trim());

  // Check last 5 parseable entries for rate_limit error
  let checked = 0;
  for (let i = lines.length - 1; i >= 0 && checked < 5; i--) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    checked++;

    if (parsed.error === 'rate_limit' && parsed.isApiErrorMessage === true) {
      const quotaMessage = parsed.message?.content?.[0]?.text || 'Rate limit reached';
      return { isQuotaDeath: true, quotaMessage };
    }
  }

  return { isQuotaDeath: false };
}

/**
 * Extract agent ID from the first user message in transcript.
 */
function extractAgentId(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    // Read first 4KB for the initial prompt
    let fd;
    try {
      fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      const match = head.match(/\[AGENT:(agent-[^\]]+)\]/);
      return match ? match[1] : null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Write a quota-interrupted session record for the session-reviver to pick up.
 */
function writeQuotaInterruptedSession(record) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }

    let data = { sessions: [] };
    if (fs.existsSync(QUOTA_INTERRUPTED_PATH)) {
      data = JSON.parse(fs.readFileSync(QUOTA_INTERRUPTED_PATH, 'utf8'));
      if (!Array.isArray(data.sessions)) data.sessions = [];
    }

    // Don't duplicate
    const existingIdx = data.sessions.findIndex(
      s => s.transcriptPath === record.transcriptPath
    );
    if (existingIdx >= 0) {
      data.sessions[existingIdx] = record;
    } else {
      data.sessions.push(record);
    }

    // Clean up entries older than 30 minutes (matches session-reviver reader window)
    const cutoff = Date.now() - 30 * 60 * 1000;
    data.sessions = data.sessions.filter(s => new Date(s.interruptedAt).getTime() > cutoff);

    fs.writeFileSync(QUOTA_INTERRUPTED_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Attempt credential rotation when quota is hit.
 * Returns true if rotation succeeded (a usable key was found and swapped).
 */
async function attemptQuotaRotation() {
  try {
    const state = readRotationState();
    if (!state.active_key_id) return false;

    // Refresh expired tokens before health-check so they can be candidates
    for (const [keyId, keyData] of Object.entries(state.keys)) {
      if (keyData.status === 'expired' && keyData.expiresAt && keyData.expiresAt < Date.now()) {
        try {
          const refreshed = await refreshExpiredToken(keyData);
          if (refreshed === 'invalid_grant') {
            keyData.status = 'invalid';
            logRotationEvent(state, {
              timestamp: Date.now(),
              event: 'key_removed',
              key_id: keyId,
              reason: 'refresh_token_invalid_grant',
            });
            debugLog(`Refresh token revoked for key ${keyId.slice(0, 8)}... — marked invalid`);
          } else if (refreshed) {
            keyData.accessToken = refreshed.accessToken;
            keyData.refreshToken = refreshed.refreshToken;
            keyData.expiresAt = refreshed.expiresAt;
            keyData.status = 'active';
            logRotationEvent(state, {
              timestamp: Date.now(),
              event: 'key_added',
              key_id: keyId,
              reason: 'token_refreshed_by_stop_hook',
            });
            debugLog(`Refreshed expired token for key ${keyId.slice(0, 8)}...`);
          }
        } catch {
          // Non-fatal: key stays expired
        }
      }
    }
    writeRotationState(state);

    // Health-check all keys to get fresh usage data
    const healthPromises = Object.entries(state.keys)
      .filter(([_, k]) => k.status !== 'invalid' && k.status !== 'expired' && k.status !== 'tombstone')
      .map(async ([keyId, keyData]) => {
        const result = await checkKeyHealth(keyData.accessToken);
        if (result.valid && result.usage) {
          keyData.last_health_check = Date.now();
          keyData.last_usage = { ...result.usage, checked_at: Date.now() };
        }
        return { keyId, result };
      });

    await Promise.all(healthPromises);
    writeRotationState(state);

    const selectedKeyId = selectActiveKey(state);
    if (selectedKeyId && selectedKeyId !== state.active_key_id) {
      const previousKeyId = state.active_key_id;
      state.active_key_id = selectedKeyId;
      const selectedKey = state.keys[selectedKeyId];
      selectedKey.last_used_at = Date.now();

      logRotationEvent(state, {
        timestamp: Date.now(),
        event: 'key_switched',
        key_id: selectedKeyId,
        reason: `stop_hook_quota_rotation_from_${previousKeyId.slice(0, 8)}`,
      });

      updateActiveCredentials(selectedKey);
      writeRotationState(state);
      debugLog('Quota rotation succeeded', { from: previousKeyId.slice(0, 8), to: selectedKeyId.slice(0, 8) });
      return true;
    }

    return false;
  } catch (err) {
    debugLog('Quota rotation error', { error: err.message });
    return false;
  }
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

    // Check for quota death BEFORE continuation logic
    // If this is a rate_limit death, don't waste the API call on a continuation
    if (isTaskSession) {
      const quotaCheck = detectQuotaDeath(input.transcript_path);
      if (quotaCheck.isQuotaDeath) {
        debugLog('Quota death detected', { quotaMessage: quotaCheck.quotaMessage });

        // Attempt credential rotation for the next session/revival
        const rotated = await attemptQuotaRotation();

        // Write recovery state for session-reviver
        const agentId = extractAgentId(input.transcript_path);
        writeQuotaInterruptedSession({
          sessionId: input.session_id || null,
          transcriptPath: input.transcript_path,
          agentId,
          quotaMessage: quotaCheck.quotaMessage,
          interruptedAt: new Date().toISOString(),
          credentialsRotated: rotated,
          status: 'pending_revival',
        });

        debugLog('Decision: APPROVE (quota death - recorded for revival)', {
          agentId,
          rotated,
          quotaMessage: quotaCheck.quotaMessage,
        });

        console.log(JSON.stringify({ decision: 'approve' }));
        process.exit(0);
      }
    }

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

  // 1. Read first 4KB of transcript file to find first user message (avoid full file read)
  if (input.transcript_path) {
    debugLog('Reading transcript head', input.transcript_path);
    try {
      let fd;
      let transcriptHead;
      try {
        fd = fs.openSync(input.transcript_path, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        transcriptHead = buf.toString('utf8', 0, bytesRead);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      const lines = transcriptHead.split('\n').filter(line => line.trim());

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
