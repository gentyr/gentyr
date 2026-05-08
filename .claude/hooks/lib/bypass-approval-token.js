/**
 * DEPRECATED: Shared module for HMAC-verified bypass approval token verification.
 *
 * This module is deprecated as part of the Unified CTO Authorization System migration.
 * All callers have been migrated to use deferred actions via `lib/deferred-action-db.js`.
 *
 * CTO bypass approval now flows through:
 *   1. PreToolUse hooks create deferred actions on block (no token file)
 *   2. Agent calls record_cto_decision with CTO's verbatim text
 *   3. Independent authorization-auditor verifies the decision
 *   4. Deferred action auto-executes on audit pass
 *
 * The `.claude/bypass-approval-token.json` file and "APPROVE BYPASS <code>"
 * pattern are being retired. This file will be removed after stabilization.
 *
 * @module bypass-approval-token
 * @deprecated Use deferred-action-db.js + record_cto_decision instead
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Verify and consume the HMAC-signed bypass approval token.
 *
 * On success: overwrites the token file with `{}` (one-time use) and returns
 * `{ valid: true, code, request_id }`.
 *
 * On failure: returns `{ valid: false, reason: '...' }`.
 *
 * On HMAC mismatch (forgery attempt): also overwrites with `{}` and logs
 * to stderr to create a visible signal.
 *
 * @param {string} projectDir - Root project directory (where `.claude/` lives).
 * @returns {{ valid: boolean, code?: string, request_id?: string, reason?: string }}
 */
export function verifyAndConsumeApprovalToken(projectDir) {
  const tokenPath = path.join(projectDir, '.claude', 'bypass-approval-token.json');

  /** Overwrite token with empty object (one-time use / forgery cleanup). */
  const clearToken = () => {
    try {
      fs.writeFileSync(tokenPath, '{}');
    } catch (_) {
      // Ignore — sticky-bit / root-owned file scenarios
    }
  };

  // --- Load protection key (G001 fail-closed) ---
  const keyPath = path.join(projectDir, '.claude', 'protection-key');
  let keyBase64;
  try {
    if (!fs.existsSync(keyPath)) {
      return { valid: false, reason: 'Protection key missing (G001 fail-closed)' };
    }
    keyBase64 = fs.readFileSync(keyPath, 'utf8').trim();
    if (!keyBase64) {
      return { valid: false, reason: 'Protection key is empty (G001 fail-closed)' };
    }
  } catch (err) {
    return { valid: false, reason: `Protection key unreadable: ${err.message} (G001 fail-closed)` };
  }

  // --- Load token file ---
  try {
    if (!fs.existsSync(tokenPath)) {
      return { valid: false, reason: 'No bypass approval token found' };
    }

    let token;
    try {
      token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    } catch (err) {
      return { valid: false, reason: `Token file unreadable or malformed: ${err.message}` };
    }

    // Empty object means token was consumed (overwrite pattern)
    if (!token.code && !token.request_id && !token.expires_timestamp) {
      return { valid: false, reason: 'Token already consumed or not yet written' };
    }

    // --- Check required fields ---
    if (!token.code || !token.request_id || !token.expires_timestamp) {
      // Possible forgery attempt: partial fields. Clear it.
      process.stderr.write('[bypass-approval-token] FORGERY DETECTED: Token missing required fields. Clearing.\n');
      clearToken();
      return { valid: false, reason: 'Token missing required fields (possible forgery)' };
    }

    // --- Check expiry ---
    if (Date.now() > token.expires_timestamp) {
      clearToken();
      return { valid: false, reason: 'Token expired (5-minute window passed)' };
    }

    // Check legacy expires_at field as well
    if (token.expires_at && new Date(token.expires_at).getTime() < Date.now()) {
      clearToken();
      return { valid: false, reason: 'Token expired (expires_at passed)' };
    }

    // --- Verify HMAC ---
    if (!token.hmac) {
      process.stderr.write('[bypass-approval-token] FORGERY DETECTED: Token missing HMAC field. Clearing.\n');
      clearToken();
      return { valid: false, reason: 'Token missing HMAC field (possible forgery)' };
    }

    const keyBuffer = Buffer.from(keyBase64, 'base64');
    const expectedHmac = crypto
      .createHmac('sha256', keyBuffer)
      .update([token.code, token.request_id, String(token.expires_timestamp), 'bypass-approved'].join('|'))
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    let hmacValid = false;
    try {
      const expectedBuf = Buffer.from(expectedHmac, 'hex');
      const actualBuf = Buffer.from(token.hmac, 'hex');
      if (expectedBuf.length === actualBuf.length) {
        hmacValid = crypto.timingSafeEqual(expectedBuf, actualBuf);
      }
    } catch (_) {
      hmacValid = false;
    }

    if (!hmacValid) {
      process.stderr.write('[bypass-approval-token] FORGERY DETECTED: Invalid HMAC on bypass token. Clearing.\n');
      clearToken();
      return { valid: false, reason: 'Token HMAC verification failed (possible forgery)' };
    }

    // --- Token is valid — consume it (one-time use) ---
    clearToken();

    return {
      valid: true,
      code: token.code,
      request_id: token.request_id,
    };
  } catch (err) {
    return { valid: false, reason: `Unexpected error verifying token: ${err.message}` };
  }
}
