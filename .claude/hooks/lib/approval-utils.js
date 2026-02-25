#!/usr/bin/env node
/**
 * Approval Utilities for Protected MCP Actions
 *
 * Provides encryption, code generation, and approval validation
 * for the CTO-protected MCP action system.
 *
 * Security Model:
 * - Credentials encrypted with AES-256-GCM
 * - Decryption key stored in .claude/protection-key (root-owned)
 * - Approval codes are 6-char alphanumeric, one-time use
 * - Approvals expire after 5 minutes
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shared buffer for non-CPU-intensive synchronous sleep via Atomics.wait
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

// ============================================================================
// Configuration
// ============================================================================

// Must match PROJECT_DIR resolution in protected-action-gate.js and
// protected-action-approval-hook.js to ensure consistent lock file paths.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..', '..');
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');
const PROTECTED_ACTIONS_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
const APPROVALS_PATH = path.join(PROJECT_DIR, '.claude', 'protected-action-approvals.json');
const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');

// Token expires after 5 minutes
const TOKEN_EXPIRY_MS = 5 * 60 * 1000;

// Lock file for TOCTOU-safe approval consumption
const LOCK_PATH = APPROVALS_PATH + '.lock';

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = '${GENTYR_ENCRYPTED:';
const ENCRYPTED_SUFFIX = '}';

// ============================================================================
// Code Generation
// ============================================================================

/**
 * Generate a 6-character alphanumeric approval code
 * Excludes confusing characters: 0/O, 1/I/L
 */
export function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomBytes[i] % chars.length);
  }
  return code;
}

// ============================================================================
// HMAC Signing (shared across hooks)
// ============================================================================

/**
 * Compute HMAC-SHA256 over pipe-delimited fields.
 * Shared function used by createRequest, checkApproval, and external hooks
 * (protected-action-gate, protected-action-approval-hook, deputy-cto server).
 *
 * @param {string} keyBase64 - Base64-encoded protection key
 * @param {...string} fields - Fields to include in HMAC
 * @returns {string} Hex-encoded HMAC
 */
export function computeHmac(keyBase64, ...fields) {
  const keyBuffer = Buffer.from(keyBase64, 'base64');
  return crypto.createHmac('sha256', keyBuffer)
    .update(fields.join('|'))
    .digest('hex');
}

// ============================================================================
// File Locking (TOCTOU protection for approval consumption)
// ============================================================================

/**
 * Acquire an advisory lock on the approvals file.
 * Uses exclusive file creation (O_CREAT | O_EXCL) as a cross-process mutex.
 * Retries with backoff for up to 2 seconds.
 * @returns {boolean} true if lock acquired
 */
export function acquireLock() {
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
      } catch { /* lock file gone, retry */ }

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
export function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch { /* already released */ }
}

// ============================================================================
// Encryption / Decryption
// ============================================================================

/**
 * Generate a new protection key
 * @returns {string} Base64-encoded key
 */
export function generateProtectionKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('base64');
}

/**
 * Read the protection key from disk
 * @returns {Buffer|null} The key buffer or null if not found
 */
export function readProtectionKey() {
  try {
    if (!fs.existsSync(PROTECTION_KEY_PATH)) {
      return null;
    }
    const keyBase64 = fs.readFileSync(PROTECTION_KEY_PATH, 'utf8').trim();
    return Buffer.from(keyBase64, 'base64');
  } catch (err) {
    console.error(`[approval-utils] Failed to read protection key: ${err.message}`);
    return null;
  }
}

/**
 * Write the protection key to disk
 * Note: Caller should ensure root ownership after writing
 * @param {string} keyBase64 - Base64-encoded key
 */
export function writeProtectionKey(keyBase64) {
  const dir = path.dirname(PROTECTION_KEY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PROTECTION_KEY_PATH, keyBase64 + '\n', { mode: 0o644 });
}

/**
 * Encrypt a credential value
 * @param {string} value - Plain text value to encrypt
 * @param {Buffer} key - Encryption key
 * @returns {string} Encrypted string in ${GENTYR_ENCRYPTED:...} format
 */
export function encryptCredential(value, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(value, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  const payload = `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  return `${ENCRYPTED_PREFIX}${payload}${ENCRYPTED_SUFFIX}`;
}

/**
 * Decrypt a credential value
 * @param {string} encryptedValue - Value in ${GENTYR_ENCRYPTED:...} format
 * @param {Buffer} key - Decryption key
 * @returns {string|null} Decrypted value or null on failure
 */
export function decryptCredential(encryptedValue, key) {
  try {
    if (!encryptedValue.startsWith(ENCRYPTED_PREFIX) || !encryptedValue.endsWith(ENCRYPTED_SUFFIX)) {
      return null;
    }

    const payload = encryptedValue.slice(ENCRYPTED_PREFIX.length, -ENCRYPTED_SUFFIX.length);
    const [ivBase64, authTagBase64, ciphertext] = payload.split(':');

    if (!ivBase64 || !authTagBase64 || !ciphertext) {
      return null;
    }

    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error(`[approval-utils] Decryption failed: ${err.message}`);
    return null;
  }
}

/**
 * Check if a value is encrypted
 * @param {string} value - Value to check
 * @returns {boolean}
 */
export function isEncrypted(value) {
  return typeof value === 'string' &&
         value.startsWith(ENCRYPTED_PREFIX) &&
         value.endsWith(ENCRYPTED_SUFFIX);
}

// ============================================================================
// Protected Actions Configuration
// ============================================================================

/**
 * Load protected actions configuration
 * @returns {object|null} Configuration or null if not found
 */
export function loadProtectedActions() {
  try {
    if (!fs.existsSync(PROTECTED_ACTIONS_PATH)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(PROTECTED_ACTIONS_PATH, 'utf8'));
  } catch (err) {
    console.error(`[approval-utils] Failed to load protected actions: ${err.message}`);
    return null;
  }
}

/**
 * Save protected actions configuration
 * @param {object} config - Configuration to save
 */
export function saveProtectedActions(config) {
  const dir = path.dirname(PROTECTED_ACTIONS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PROTECTED_ACTIONS_PATH, JSON.stringify(config, null, 2));
}

/**
 * Check if a server:tool is protected
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} config - Protected actions config (optional, loads if not provided)
 * @returns {object|null} Protection config or null if not protected
 */
export function getProtection(server, tool, config = null) {
  const cfg = config || loadProtectedActions();
  if (!cfg || !cfg.servers || !cfg.servers[server]) {
    return null;
  }

  const serverConfig = cfg.servers[server];

  // Check if this tool is protected
  if (serverConfig.tools === '*') {
    return serverConfig;
  }

  if (Array.isArray(serverConfig.tools) && serverConfig.tools.includes(tool)) {
    return serverConfig;
  }

  return null;
}

// ============================================================================
// Approval Management
// ============================================================================

/**
 * Load current approvals
 * @returns {object} Approvals object (may be empty)
 */
export function loadApprovals() {
  try {
    if (!fs.existsSync(APPROVALS_PATH)) {
      return { approvals: {} };
    }
    const data = JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf8'));
    if (!data || typeof data !== 'object' || !data.approvals || typeof data.approvals !== 'object') {
      return { approvals: {} };
    }
    return data;
  } catch (err) {
    return { approvals: {} };
  }
}

/**
 * Save approvals
 * @param {object} approvals - Approvals object
 */
export function saveApprovals(approvals) {
  const dir = path.dirname(APPROVALS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = APPROVALS_PATH + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(approvals, null, 2));
    fs.renameSync(tmpPath, APPROVALS_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Create a pending approval request
 * @param {string} server - MCP server name (or '__file__' for file approvals)
 * @param {string} tool - Tool name (or file config key for file approvals)
 * @param {object} args - Tool arguments
 * @param {string} phrase - Approval phrase (e.g., "APPROVE PROD")
 * @param {object} [options] - Additional options
 * @param {string} [options.approvalMode] - 'cto' (default) or 'deputy-cto'
 * @returns {object} Request details including code
 */
export function createRequest(server, tool, args, phrase, options = {}) {
  const code = generateCode();
  const now = Date.now();
  const expiresTimestamp = now + TOKEN_EXPIRY_MS;

  // Hash the args to bind the approval to these specific arguments
  const argsHash = crypto.createHash('sha256')
    .update(JSON.stringify(args || {}))
    .digest('hex');

  // Compute HMAC for pending request (prevents agent forgery)
  const key = readProtectionKey();
  const keyBase64 = key ? key.toString('base64') : null;
  let pendingHmac;
  if (keyBase64) {
    pendingHmac = computeHmac(keyBase64, code, server, tool, argsHash, String(expiresTimestamp));
  }

  // Acquire lock for atomic read-modify-write
  if (!acquireLock()) {
    console.error('[approval-utils] Warning: Could not acquire lock for createRequest. Proceeding without lock.');
  }

  try {
    const approvals = loadApprovals();
    approvals.approvals[code] = {
      server,
      tool,
      args,
      argsHash,
      phrase,
      code,
      status: 'pending',
      approval_mode: options.approvalMode || 'cto',
      created_at: new Date(now).toISOString(),
      created_timestamp: now,
      expires_at: new Date(expiresTimestamp).toISOString(),
      expires_timestamp: expiresTimestamp,
      ...(pendingHmac && { pending_hmac: pendingHmac }),
    };

    // Clean expired requests
    const validApprovals = {};
    for (const [k, val] of Object.entries(approvals.approvals)) {
      if (val.expires_timestamp > now) {
        validApprovals[k] = val;
      }
    }
    approvals.approvals = validApprovals;

    saveApprovals(approvals);
  } finally {
    releaseLock();
  }

  return {
    code,
    server,
    tool,
    phrase,
    message: `CTO must type: ${phrase} ${code}`,
    expires_in_minutes: Math.round(TOKEN_EXPIRY_MS / 60000),
  };
}

/**
 * Validate an approval code and mark as approved
 * @param {string} phrase - The approval phrase (e.g., "APPROVE PROD")
 * @param {string} code - The 6-character code
 * @returns {object} Validation result
 */
export function validateApproval(phrase, code) {
  // Acquire lock to prevent TOCTOU race: concurrent validation + consumption of same request
  if (!acquireLock()) {
    console.error('[approval-utils] G001 FAIL-CLOSED: Could not acquire approvals lock for validateApproval.');
    return { valid: false, reason: 'Could not acquire file lock' };
  }

  try {
    const approvals = loadApprovals();
    const request = approvals.approvals[code.toUpperCase()];

    if (!request) {
      return { valid: false, reason: 'No pending request with this code' };
    }

    if (request.status === 'approved') {
      return { valid: false, reason: 'This code has already been used' };
    }

    if (Date.now() > request.expires_timestamp) {
      // Clean up expired request
      delete approvals.approvals[code.toUpperCase()];
      saveApprovals(approvals);
      return { valid: false, reason: 'Approval code has expired' };
    }

    // Verify phrase matches (case-insensitive)
    if (request.phrase.toUpperCase() !== phrase.toUpperCase()) {
      return {
        valid: false,
        reason: `Wrong approval phrase. Expected: ${request.phrase}`
      };
    }

    // HMAC verification: Verify the pending request was created by the gate hook.
    // G001 Fail-Closed: pending_hmac is verified unconditionally when a protection key is
    // present. If the field is missing (undefined), the comparison against the expected hex
    // string fails correctly, blocking requests that were not created by the gate hook.
    const key = readProtectionKey();
    const keyBase64 = key ? key.toString('base64') : null;
    const normalizedCode = code.toUpperCase();

    if (keyBase64) {
      // Unconditionally verify pending_hmac - if field is missing, comparison fails correctly
      const expectedPendingHmac = computeHmac(keyBase64, normalizedCode, request.server, request.tool, request.argsHash || '', String(request.expires_timestamp));
      if (request.pending_hmac !== expectedPendingHmac) {
        // Forged or missing pending_hmac - delete and reject
        console.error(`[approval-utils] FORGERY DETECTED: Invalid pending_hmac for ${normalizedCode}. Deleting.`);
        delete approvals.approvals[normalizedCode];
        saveApprovals(approvals);
        return { valid: false, reason: 'FORGERY: Invalid request signature' };
      }
    } else if (!keyBase64 && request.pending_hmac) {
      // G001 Fail-Closed: Request has HMAC but we can't verify (key missing)
      console.error(`[approval-utils] G001 FAIL-CLOSED: Cannot verify HMAC for ${normalizedCode} (protection key missing).`);
      return { valid: false, reason: 'Cannot verify request signature (protection key missing)' };
    }

    // Mark as approved
    request.status = 'approved';
    request.approved_at = new Date().toISOString();
    request.approved_timestamp = Date.now();
    if (keyBase64) {
      request.approved_hmac = computeHmac(keyBase64, normalizedCode, request.server, request.tool, 'approved', request.argsHash || '', String(request.expires_timestamp));
    }
    saveApprovals(approvals);

    return {
      valid: true,
      server: request.server,
      tool: request.tool,
      args: request.args,
      request,
    };
  } finally {
    releaseLock();
  }
}

/**
 * Check if there's a valid approval for a server:tool call.
 * Verifies HMAC signatures to prevent agent forgery.
 * Uses file locking to prevent TOCTOU race conditions on approval consumption.
 *
 * @param {string} server - MCP server name (or '__file__' for file approvals)
 * @param {string} tool - Tool name (or file config key for file approvals)
 * @param {object} [args] - Tool arguments (used to verify approval is scoped to these exact args)
 * @returns {object|null} Approval if valid, null otherwise
 */
export function checkApproval(server, tool, args) {
  // Acquire lock to prevent TOCTOU race: two concurrent checks consuming same approval
  if (!acquireLock()) {
    console.error('[approval-utils] G001 FAIL-CLOSED: Could not acquire approvals lock. Blocking action.');
    return null;
  }

  try {
    const approvals = loadApprovals();
    const now = Date.now();
    const key = readProtectionKey();
    const keyBase64 = key ? key.toString('base64') : null;
    let dirty = false;

    // Hash the current call's arguments to verify they match the approved args
    const argsHash = crypto.createHash('sha256')
      .update(JSON.stringify(args || {}))
      .digest('hex');

    // Pass 1: Standard exact-match approvals (args-bound, single-use)
    for (const [code, request] of Object.entries(approvals.approvals)) {
      // Skip pre-approvals — they use different HMAC domains and are handled in Pass 2
      if (request.is_preapproval) continue;
      if (request.status !== 'approved') continue;
      if (request.expires_timestamp < now) continue;
      if (request.server !== server) continue;
      if (request.tool !== tool) continue;

      // Verify args match what was approved (prevents bait-and-switch attack)
      if (request.argsHash && request.argsHash !== argsHash) {
        continue; // Args don't match the approved request
      }

      // HMAC verification: Verify signatures to prevent agent forgery.
      // G001 Fail-Closed: Both pending_hmac and approved_hmac are verified unconditionally
      // when a protection key is present. If either field is missing (undefined), the
      // comparison against the expected hex string will fail, correctly blocking the request.
      if (keyBase64) {
        // Verify pending_hmac unconditionally - if field is missing, comparison fails correctly
        const expectedPendingHmac = computeHmac(keyBase64, code, server, tool, request.argsHash || argsHash, String(request.expires_timestamp));
        if (request.pending_hmac !== expectedPendingHmac) {
          console.error(`[approval-utils] FORGERY DETECTED: Invalid pending_hmac for ${code}. Deleting.`);
          delete approvals.approvals[code];
          dirty = true;
          continue;
        }

        // Verify approved_hmac unconditionally - if field is missing, comparison fails correctly
        const expectedApprovedHmac = computeHmac(keyBase64, code, server, tool, 'approved', request.argsHash || argsHash, String(request.expires_timestamp));
        if (request.approved_hmac !== expectedApprovedHmac) {
          console.error(`[approval-utils] FORGERY DETECTED: Invalid approved_hmac for ${code}. Deleting.`);
          delete approvals.approvals[code];
          dirty = true;
          continue;
        }
      } else if (request.pending_hmac || request.approved_hmac) {
        // G001 Fail-Closed: Request has HMAC fields but we can't verify them
        // (protection key missing/unreadable). Reject rather than skip verification.
        console.error(`[approval-utils] G001 FAIL-CLOSED: Cannot verify HMAC for ${code} (protection key missing). Skipping.`);
        continue;
      }

      // Found a valid, HMAC-verified approval - consume it (one-time use)
      delete approvals.approvals[code];
      saveApprovals(approvals);

      return request;
    }

    // Pass 2: Pre-approved bypasses (args-agnostic, burst-use)
    for (const [code, request] of Object.entries(approvals.approvals)) {
      if (!request.is_preapproval) continue;
      if (request.status !== 'approved') continue;
      if (request.expires_timestamp < now) continue;
      if (request.server !== server) continue;
      if (request.tool !== tool) continue;

      // HMAC verification for pre-approvals (domain-separated from standard approvals)
      if (keyBase64) {
        const expectedPendingHmac = computeHmac(keyBase64, code, server, tool, 'preapproval-pending', String(request.expires_timestamp));
        if (request.pending_hmac !== expectedPendingHmac) {
          console.error(`[approval-utils] FORGERY DETECTED: Invalid pending_hmac for pre-approval ${code}. Deleting.`);
          delete approvals.approvals[code];
          dirty = true;
          continue;
        }

        const expectedApprovedHmac = computeHmac(keyBase64, code, server, tool, 'preapproval-activated', String(request.expires_timestamp));
        if (request.approved_hmac !== expectedApprovedHmac) {
          console.error(`[approval-utils] FORGERY DETECTED: Invalid approved_hmac for pre-approval ${code}. Deleting.`);
          delete approvals.approvals[code];
          dirty = true;
          continue;
        }
      } else {
        // G001 Fail-Closed: No protection key available — reject pre-approval unconditionally.
        // Without a key we cannot verify HMAC integrity, so we must block regardless of
        // whether HMAC fields are present (prevents forged entries without HMAC fields).
        console.error(`[approval-utils] G001 FAIL-CLOSED: Cannot verify HMAC for pre-approval ${code} (protection key missing). Skipping.`);
        continue;
      }

      // Burst-use logic
      if (!request.uses_remaining || request.uses_remaining <= 0) {
        delete approvals.approvals[code];
        dirty = true;
        continue;
      }

      // Check burst window: if previously used, subsequent uses must be within 60s
      if (request.last_used_timestamp) {
        const elapsed = now - request.last_used_timestamp;
        const burstWindow = request.burst_window_ms || 60000;
        if (elapsed > burstWindow) {
          console.error(`[approval-utils] Pre-approval ${code} burst window expired (${elapsed}ms > ${burstWindow}ms). Deleting.`);
          delete approvals.approvals[code];
          dirty = true;
          continue;
        }
      }

      // Consume one use
      request.uses_remaining--;
      request.last_used_timestamp = now;
      console.error(`[approval-utils] Pre-approval ${code} consumed for ${server}:${tool} (${request.uses_remaining} uses remaining, reason: ${request.reason || 'N/A'})`);

      if (request.uses_remaining <= 0) {
        // Fully consumed
        delete approvals.approvals[code];
      }

      saveApprovals(approvals);
      return request;
    }

    // Save if we deleted forged entries
    if (dirty) {
      saveApprovals(approvals);
    }

    return null;
  } finally {
    releaseLock();
  }
}

/**
 * Get all pending requests (for display/debugging)
 * @returns {object[]} List of pending requests
 */
export function getPendingRequests() {
  const approvals = loadApprovals();
  const now = Date.now();

  return Object.values(approvals.approvals)
    .filter(r => r.status === 'pending' && r.expires_timestamp > now)
    .map(r => ({
      code: r.code,
      server: r.server,
      tool: r.tool,
      phrase: r.phrase,
      created_at: r.created_at,
      expires_at: r.expires_at,
    }));
}

// ============================================================================
// Database Helpers (for integration with deputy-cto.db)
// ============================================================================

/**
 * Create a protected-action-request in deputy-cto.db
 * This allows the request to show up in CTO notifications
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments
 * @param {string} code - Approval code
 * @param {string} phrase - Approval phrase
 * @returns {string|null} Question ID or null on failure
 */
export async function createDbRequest(server, tool, args, code, phrase) {
  try {
    const Database = (await import('better-sqlite3')).default;

    if (!fs.existsSync(DEPUTY_CTO_DB)) {
      console.error('[approval-utils] deputy-cto.db not found');
      return null;
    }

    const db = new Database(DEPUTY_CTO_DB);
    const id = crypto.randomUUID();
    const now = new Date();

    const description = `**Protected Action Request**

**Server:** ${server}
**Tool:** ${tool}
**Arguments:** \`\`\`json
${JSON.stringify(args, null, 2)}
\`\`\`

---

**CTO Action Required:**
To approve this action, type exactly: **${phrase} ${code}**

This approval will expire in 5 minutes.`;

    const context = JSON.stringify({ code, server, tool, args, phrase });

    db.prepare(`
      INSERT INTO questions (id, type, status, title, description, context, created_at, created_timestamp)
      VALUES (?, 'protected-action-request', 'pending', ?, ?, ?, ?, ?)
    `).run(
      id,
      `Protected Action: ${server}:${tool}`,
      description,
      context,
      now.toISOString(),
      Math.floor(now.getTime() / 1000)
    );

    db.close();
    return id;
  } catch (err) {
    console.error(`[approval-utils] Failed to create DB request: ${err.message}`);
    return null;
  }
}

/**
 * Validate an approval code against deputy-cto.db
 * @param {string} code - The 6-character code
 * @returns {object} Validation result with question details
 */
export async function validateDbApproval(code) {
  try {
    const Database = (await import('better-sqlite3')).default;

    if (!fs.existsSync(DEPUTY_CTO_DB)) {
      return { valid: false, reason: 'Database not found' };
    }

    const db = new Database(DEPUTY_CTO_DB, { readonly: true });

    // Look for pending protected-action-request with this code in context
    const question = db.prepare(`
      SELECT id, title, context, created_at FROM questions
      WHERE type = 'protected-action-request'
      AND status = 'pending'
      AND context LIKE ?
    `).get(`%"code":"${code}"%`);

    db.close();

    if (!question) {
      return { valid: false, reason: 'No pending request with this code' };
    }

    const context = JSON.parse(question.context);

    return {
      valid: true,
      question_id: question.id,
      server: context.server,
      tool: context.tool,
      args: context.args,
      phrase: context.phrase,
      created_at: question.created_at,
    };
  } catch (err) {
    return { valid: false, reason: `Database error: ${err.message}` };
  }
}

/**
 * Mark a protected-action-request as answered in deputy-cto.db
 * @param {string} questionId - Question UUID
 */
export async function markDbRequestApproved(questionId) {
  try {
    const Database = (await import('better-sqlite3')).default;

    if (!fs.existsSync(DEPUTY_CTO_DB)) {
      return;
    }

    const db = new Database(DEPUTY_CTO_DB);

    db.prepare(`
      UPDATE questions
      SET status = 'answered', answer = 'APPROVED', answered_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), questionId);

    db.close();
  } catch (err) {
    console.error(`[approval-utils] Failed to mark request approved: ${err.message}`);
  }
}

// ============================================================================
// Exports
// ============================================================================

export default {
  // Code generation
  generateCode,

  // HMAC
  computeHmac,

  // Encryption
  generateProtectionKey,
  readProtectionKey,
  writeProtectionKey,
  encryptCredential,
  decryptCredential,
  isEncrypted,

  // Configuration
  loadProtectedActions,
  saveProtectedActions,
  getProtection,

  // Approvals
  loadApprovals,
  saveApprovals,
  createRequest,
  validateApproval,
  checkApproval,
  getPendingRequests,

  // Database integration
  createDbRequest,
  validateDbApproval,
  markDbRequestApproved,

  // File locking
  acquireLock,
  releaseLock,

  // Constants
  PROTECTION_KEY_PATH,
  PROTECTED_ACTIONS_PATH,
  APPROVALS_PATH,
  TOKEN_EXPIRY_MS,
};
