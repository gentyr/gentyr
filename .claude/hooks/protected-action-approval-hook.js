#!/usr/bin/env node
/**
 * DEPRECATED: Protected Action Approval Hook (UserPromptSubmit)
 *
 * This hook is deprecated as of Phase 3 of the Unified CTO Authorization System.
 * CTO approval now flows through `record_cto_decision` on the agent-tracker server,
 * which provides JSONL verbatim verification and independent auditor verification
 * before auto-executing the deferred action.
 *
 * This file will be removed from settings.json.template in Phase 5.
 * Until then, it remains registered but its primary flow (writing to
 * protected-action-approvals.json) is no longer consumed by the gate hook.
 * The deferred action path (checkAndExecuteDeferred) is also superseded by
 * the deferred-action-audit-executor.js PostToolUse hook.
 *
 * Previously watched for CTO approval messages in the format:
 *   APPROVE <PHRASE> <6-char-code>
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 2.0.0
 * @deprecated Phase 3 of Unified CTO Authorization System — use record_cto_decision instead
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shared buffer for non-CPU-intensive synchronous sleep via Atomics.wait
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const PROTECTED_ACTIONS_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
const APPROVALS_PATH = path.join(PROJECT_DIR, '.claude', 'protected-action-approvals.json');
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');
const LOCK_PATH = APPROVALS_PATH + '.lock';

// ============================================================================
// File Locking (TOCTOU protection for approval consumption)
// ============================================================================

/**
 * Acquire an advisory lock on the approvals file.
 * Uses exclusive file creation (O_CREAT | O_EXCL) as a cross-process mutex.
 * Retries with backoff for up to 2 seconds.
 * @returns {boolean} true if lock acquired
 */
function acquireLock() {
  const maxAttempts = 10;
  const baseDelay = 50; // ms
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const fd = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      // Check for stale lock (older than 10 seconds)
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.unlinkSync(LOCK_PATH);
          continue; // Retry immediately after removing stale lock
        }
      } catch (_) { /* cleanup - failure expected */ /* lock file gone, retry */ }

      // Exponential backoff
      const delay = baseDelay * Math.pow(2, i);
      Atomics.wait(_sleepBuf, 0, 0, delay);
    }
  }
  return false;
}

/**
 * Release the advisory lock.
 */
function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (_) { /* cleanup - failure expected */ /* already released */ }
}

// ============================================================================
// HMAC Signing (Fix 2: Anti-Forgery)
// ============================================================================

/**
 * Load the protection key for HMAC signing.
 * @returns {string|null} Base64-encoded key or null
 */
function loadProtectionKey() {
  try {
    if (!fs.existsSync(PROTECTION_KEY_PATH)) {
      return null;
    }
    return fs.readFileSync(PROTECTION_KEY_PATH, 'utf8').trim();
  } catch (err) {
    return null;
  }
}

/**
 * Compute HMAC-SHA256 over pipe-delimited fields.
 * @param {string} key - Base64-encoded key
 * @param {...string} fields - Fields to include in HMAC
 * @returns {string} Hex-encoded HMAC
 */
function computeHmac(key, ...fields) {
  const keyBuffer = Buffer.from(key, 'base64');
  return crypto.createHmac('sha256', keyBuffer)
    .update(fields.join('|'))
    .digest('hex');
}

// Pattern to match: APPROVE <PHRASE> <CODE>
// PHRASE can be one or more words (e.g., "PROD", "PROD DB", "PAYMENT")
// CODE is exactly 6 alphanumeric characters
const APPROVAL_PATTERN = /APPROVE\s+(.+?)\s+([A-Z0-9]{6})\b/i;

// ============================================================================
// Input Reading
// ============================================================================

/**
 * Read user message from stdin (passed by Claude Code for UserPromptSubmit hooks)
 */
async function readUserMessage() {
  return new Promise((resolve) => {
    let data = '';

    // Set a short timeout in case no data is available
    const timeout = setTimeout(() => {
      resolve(data.trim());
    }, 100);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(data.trim());
    });

    // If stdin is not readable, resolve immediately
    if (!process.stdin.readable) {
      clearTimeout(timeout);
      resolve('');
    }
  });
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Load protected actions configuration to get valid phrases
 * @returns {object|null}
 */
function loadProtectedActions() {
  try {
    if (!fs.existsSync(PROTECTED_ACTIONS_PATH)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(PROTECTED_ACTIONS_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Get all valid approval phrases from config
 * @param {object} config
 * @returns {string[]}
 */
function getValidPhrases(config) {
  const phrases = [];
  if (config?.servers) {
    for (const s of Object.values(config.servers)) {
      if (s.phrase) phrases.push(s.phrase.toUpperCase());
    }
  }
  if (config?.files) {
    for (const f of Object.values(config.files)) {
      if (f.phrase) phrases.push(f.phrase.toUpperCase());
    }
  }
  return phrases;
}

// ============================================================================
// Approval Management
// ============================================================================

/**
 * Load current approvals
 * @returns {object}
 */
function loadApprovals() {
  try {
    if (!fs.existsSync(APPROVALS_PATH)) {
      return { approvals: {} };
    }
    return JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf8'));
  } catch (err) {
    return { approvals: {} };
  }
}

/**
 * Save approvals
 * @param {object} approvals
 */
function saveApprovals(approvals) {
  const dir = path.dirname(APPROVALS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = APPROVALS_PATH + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(approvals, null, 2));
    fs.renameSync(tmpPath, APPROVALS_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* cleanup - failure expected */}
    throw err;
  }
}

/**
 * Validate and approve a request with HMAC verification (Fix 2).
 * @param {string} phrase - The approval phrase (e.g., "PROD")
 * @param {string} code - The 6-character code
 * @returns {object} Validation result
 */
function validateAndApprove(phrase, code) {
  // Acquire lock to prevent TOCTOU race: concurrent approval + consumption of same request
  if (!acquireLock()) {
    console.error('[protected-action-approval] G001 FAIL-CLOSED: Could not acquire approvals lock.');
    return { valid: false, reason: 'Could not acquire file lock' };
  }

  try {
    const approvals = loadApprovals();
    const normalizedCode = code.toUpperCase();
    const request = approvals.approvals[normalizedCode];

    if (!request) {
      return { valid: false, reason: 'No pending request with this code' };
    }

    if (request.status === 'approved') {
      return { valid: false, reason: 'This code has already been used' };
    }

    if (Date.now() > request.expires_timestamp) {
      // Clean up expired request
      delete approvals.approvals[normalizedCode];
      saveApprovals(approvals);
      return { valid: false, reason: 'Approval code has expired' };
    }

    // HMAC verification: Verify the pending request was created by the gate hook.
    // G001 Fail-Closed: pending_hmac is verified unconditionally when a protection key is
    // present. If the field is missing (undefined), the comparison against the expected hex
    // string fails correctly, blocking requests that were not created by the gate hook.
    const key = loadProtectionKey();
    if (key) {
      const expectedPendingHmac = computeHmac(key, normalizedCode, request.server, request.tool, request.argsHash || '', String(request.expires_timestamp));
      if (request.pending_hmac !== expectedPendingHmac) {
        // Forged pending request — delete and reject
        console.error(`[protected-action-approval] FORGERY DETECTED: Invalid pending_hmac for ${normalizedCode}. Deleting.`);
        delete approvals.approvals[normalizedCode];
        saveApprovals(approvals);
        return { valid: false, reason: 'FORGERY: Invalid request signature' };
      }
    } else if (!key && request.pending_hmac) {
      // G001 Fail-Closed: Request has HMAC but we can't verify (key missing)
      console.error(`[protected-action-approval] G001 FAIL-CLOSED: Cannot verify HMAC for ${normalizedCode} (protection key missing).`);
      return { valid: false, reason: 'Cannot verify request signature (protection key missing)' };
    }

    // Extract the expected phrase from the stored full phrase (e.g., "APPROVE PROD" -> "PROD")
    const storedPhrase = request.phrase.toUpperCase();
    const expectedPhrase = storedPhrase.replace(/^APPROVE\s+/i, '');
    const providedPhrase = phrase.toUpperCase();

    // Check if the provided phrase matches the expected phrase
    if (providedPhrase !== expectedPhrase && providedPhrase !== storedPhrase) {
      return {
        valid: false,
        reason: `Wrong approval phrase. Expected: APPROVE ${expectedPhrase}`
      };
    }

    // Mark as approved with HMAC signature (Fix 2)
    request.status = 'approved';
    request.approved_at = new Date().toISOString();
    request.approved_timestamp = Date.now();
    if (key) {
      request.approved_hmac = computeHmac(key, normalizedCode, request.server, request.tool, 'approved', request.argsHash || '', String(request.expires_timestamp));
    }
    saveApprovals(approvals);

    return {
      valid: true,
      server: request.server,
      tool: request.tool,
      code: normalizedCode,
    };
  } finally {
    releaseLock();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const userMessage = await readUserMessage();

  if (!userMessage) {
    // No message, nothing to do
    process.exit(0);
  }

  // Skip for slash commands (contain GENTYR sentinel markers)
  if (userMessage.includes('<!-- HOOK:GENTYR:')) {
    process.exit(0);
  }

  // Check if message matches approval pattern
  const match = userMessage.match(APPROVAL_PATTERN);

  if (!match) {
    // Not an approval message, pass through silently
    process.exit(0);
  }

  const phrase = match[1].trim();
  const code = match[2].toUpperCase();

  // Load config to check if this is a valid phrase
  const config = loadProtectedActions();
  const validPhrases = getValidPhrases(config);

  // Normalize the provided phrase for comparison
  const normalizedPhrase = phrase.toUpperCase();

  // Check if this looks like a protected action approval
  // (vs. the bypass approval which uses "APPROVE BYPASS")
  if (normalizedPhrase === 'BYPASS') {
    // Let bypass-approval-hook.js handle this
    process.exit(0);
  }

  // If we have a config, check if the phrase is valid
  if (config && validPhrases.length > 0) {
    const isValidPhrase = validPhrases.some(p =>
      normalizedPhrase === p.replace(/^APPROVE\s+/i, '') ||
      normalizedPhrase === p
    );

    if (!isValidPhrase) {
      // Not a recognized phrase, might be intended for something else
      // Log but don't block
      console.error(`[protected-action-approval] Unrecognized phrase: "${phrase}"`);
      console.error(`[protected-action-approval] Valid phrases: ${validPhrases.join(', ')}`);
      process.exit(0);
    }
  }

  // ── Check deferred actions DB first (spawned agent fire-and-forget path) ──
  const deferredResult = await checkAndExecuteDeferred(code, phrase);
  if (deferredResult) {
    // Handled as deferred action — output shown by checkAndExecuteDeferred
    process.exit(0);
  }

  // ── Standard file-based approval (interactive agent retry path) ───────────
  const result = validateAndApprove(phrase, code);

  if (!result.valid) {
    console.error(`[protected-action-approval] Invalid approval: ${result.reason}`);
    process.exit(0); // Don't block the user's message, just log warning
  }

  // Success!
  console.error('');
  console.error('══════════════════════════════════════════════════════════════════════');
  console.error('  PROTECTED ACTION APPROVED');
  console.error('');
  console.error(`  Server: ${result.server}`);
  console.error(`  Tool:   ${result.tool}`);
  console.error(`  Code:   ${result.code}`);
  console.error('');
  console.error('  The agent can now retry the protected action.');
  console.error('  This approval is valid for 5 minutes and can only be used once.');
  console.error('══════════════════════════════════════════════════════════════════════');
  console.error('');

  process.exit(0);
}

// ============================================================================
// Deferred Action Handling
// ============================================================================

/**
 * Check if the approval code matches a deferred action and execute it.
 * Returns true if handled (whether success or failure), false if not a deferred action.
 */
async function checkAndExecuteDeferred(code, phrase) {
  try {
    const { openDb, getDeferredActionByCode, markApproved } = await import('./lib/deferred-action-db.js');
    const { computeApprovedHmac, verifyActionHmac, executeAction, isTier1Server } = await import('./lib/deferred-action-executor.js');

    const db = openDb();
    if (!db) return false;

    try {
      const action = getDeferredActionByCode(db, code);
      if (!action) return false; // Not a deferred action — let standard path handle it

      if (action.status !== 'pending') {
        console.error(`[protected-action-approval] Deferred action ${code} is already ${action.status}.`);
        return true; // Handled — don't fall through to standard path
      }

      // Verify the phrase matches
      const storedPhrase = action.phrase.toUpperCase();
      const expectedPhrase = storedPhrase.replace(/^APPROVE\s+/i, '');
      const normalizedPhrase = phrase.toUpperCase();
      if (normalizedPhrase !== expectedPhrase && normalizedPhrase !== storedPhrase) {
        console.error(`[protected-action-approval] Wrong phrase for deferred action. Expected: APPROVE ${expectedPhrase}`);
        return true;
      }

      // Verify pending HMAC before approving (G001: must verify creation integrity)
      const key = loadProtectionKey();
      if (!key) {
        console.error('[protected-action-approval] G001 FAIL-CLOSED: Protection key missing for deferred action.');
        return true;
      }

      // Verify the pending_hmac was created by the gate hook (not forged)
      const { computePendingHmac } = await import('./lib/deferred-action-executor.js');
      const expectedPendingHmac = computePendingHmac(action.code, action.server, action.tool, action.args_hash);
      if (!expectedPendingHmac || action.pending_hmac !== expectedPendingHmac) {
        console.error(`[protected-action-approval] FORGERY DETECTED: Invalid pending_hmac for deferred action ${code}. Rejecting.`);
        // Mark failed rather than leaving in pending state
        const { markFailed } = await import('./lib/deferred-action-db.js');
        markFailed(db, action.id, 'Pending HMAC verification failed — possible forgery');
        return true;
      }

      // Compute and store the approved HMAC
      const approvedHmac = computeApprovedHmac(action.code, action.server, action.tool, action.args_hash);
      if (!approvedHmac) {
        console.error('[protected-action-approval] Could not compute approved HMAC.');
        return true;
      }

      markApproved(db, action.id, approvedHmac);

      // Re-read the action with approved_hmac populated
      const approvedAction = getDeferredActionByCode(db, code);

      // Check if this is a Tier 1 server
      if (!isTier1Server(action.server)) {
        console.error('');
        console.error('══════════════════════════════════════════════════════════════════════');
        console.error('  DEFERRED ACTION APPROVED (manual execution required)');
        console.error('');
        console.error(`  Server: ${action.server}`);
        console.error(`  Tool:   ${action.tool}`);
        console.error(`  Code:   ${action.code}`);
        console.error('');
        console.error(`  Server "${action.server}" is a Tier 2 server (per-session stdio).`);
        console.error('  Automatic execution is only supported for Tier 1 servers.');
        console.error('  Please execute this action manually:');
        console.error(`    mcp__${action.server}__${action.tool}(${JSON.stringify(typeof action.args === 'string' ? JSON.parse(action.args) : action.args)})`);
        console.error('══════════════════════════════════════════════════════════════════════');
        console.error('');
        return true;
      }

      // Execute the action via MCP daemon
      console.error('');
      console.error('══════════════════════════════════════════════════════════════════════');
      console.error('  DEFERRED ACTION APPROVED — Executing...');
      console.error('');
      console.error(`  Server: ${action.server}`);
      console.error(`  Tool:   ${action.tool}`);
      console.error(`  Code:   ${action.code}`);
      console.error('══════════════════════════════════════════════════════════════════════');
      console.error('');

      const execResult = await executeAction(db, approvedAction);

      if (execResult.success) {
        // Summarize the result for the CTO
        let resultSummary = '';
        try {
          const content = execResult.result?.content;
          if (Array.isArray(content)) {
            resultSummary = content.map(c => c.text || c.type).join('\n');
          } else if (typeof execResult.result === 'string') {
            resultSummary = execResult.result;
          } else {
            resultSummary = JSON.stringify(execResult.result, null, 2);
          }
          if (resultSummary.length > 1000) {
            resultSummary = resultSummary.slice(0, 997) + '...';
          }
        } catch { resultSummary = '(result available in DB)'; }

        console.error('══════════════════════════════════════════════════════════════════════');
        console.error('  DEFERRED ACTION EXECUTED SUCCESSFULLY');
        console.error('');
        console.error(`  Server: ${action.server}`);
        console.error(`  Tool:   ${action.tool}`);
        console.error('');
        if (resultSummary) {
          console.error('  Result:');
          resultSummary.split('\n').forEach(line => console.error(`    ${line}`));
        }
        console.error('══════════════════════════════════════════════════════════════════════');
        console.error('');

        // Signal the original agent if alive
        await signalRequester(action, execResult);
      } else {
        console.error('══════════════════════════════════════════════════════════════════════');
        console.error('  DEFERRED ACTION FAILED');
        console.error('');
        console.error(`  Server: ${action.server}`);
        console.error(`  Tool:   ${action.tool}`);
        console.error(`  Error:  ${execResult.error}`);
        console.error('══════════════════════════════════════════════════════════════════════');
        console.error('');
      }

      return true;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[protected-action-approval] Deferred action check error: ${err.message}`);
    return false; // Fall through to standard path on error
  }
}

/**
 * Notify the original requesting agent that its deferred action completed.
 * Non-fatal — best-effort signal delivery.
 */
async function signalRequester(action, execResult) {
  if (!action.requester_agent_id) return;
  try {
    const { sendSignal } = await import('./lib/session-signals.js');
    const status = execResult.success ? 'completed' : 'failed';
    const message = execResult.success
      ? `[DEFERRED ACTION COMPLETED] ${action.server}:${action.tool} executed successfully. Code: ${action.code}`
      : `[DEFERRED ACTION FAILED] ${action.server}:${action.tool} failed: ${execResult.error}. Code: ${action.code}`;

    sendSignal(action.requester_agent_id, 'deferred_action_result', message, {
      action_id: action.id,
      code: action.code,
      server: action.server,
      tool: action.tool,
      status,
    });
  } catch {
    // Non-fatal — agent may already be dead
  }
}

main().catch((err) => {
  console.error(`[protected-action-approval] Error: ${err.message}`);
  process.exit(0); // Don't block on errors
});
