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

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');
const PROTECTED_ACTIONS_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
const APPROVALS_PATH = path.join(PROJECT_DIR, '.claude', 'protected-action-approvals.json');
const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');

// Token expires after 5 minutes
const TOKEN_EXPIRY_MS = 5 * 60 * 1000;

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
  fs.writeFileSync(PROTECTION_KEY_PATH, keyBase64 + '\n', { mode: 0o600 });
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
    return JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf8'));
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
  fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals, null, 2));
}

/**
 * Create a pending approval request
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments
 * @param {string} phrase - Approval phrase (e.g., "APPROVE PROD")
 * @returns {object} Request details including code
 */
export function createRequest(server, tool, args, phrase) {
  const code = generateCode();
  const now = Date.now();

  const approvals = loadApprovals();
  approvals.approvals[code] = {
    server,
    tool,
    args,
    phrase,
    code,
    status: 'pending',
    created_at: new Date(now).toISOString(),
    created_timestamp: now,
    expires_at: new Date(now + TOKEN_EXPIRY_MS).toISOString(),
    expires_timestamp: now + TOKEN_EXPIRY_MS,
  };

  // Clean expired requests
  const validApprovals = {};
  for (const [key, val] of Object.entries(approvals.approvals)) {
    if (val.expires_timestamp > now) {
      validApprovals[key] = val;
    }
  }
  approvals.approvals = validApprovals;

  saveApprovals(approvals);

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

  // Mark as approved
  request.status = 'approved';
  request.approved_at = new Date().toISOString();
  request.approved_timestamp = Date.now();
  saveApprovals(approvals);

  return {
    valid: true,
    server: request.server,
    tool: request.tool,
    args: request.args,
    request,
  };
}

/**
 * Check if there's a valid approval for a server:tool call
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments (for matching)
 * @returns {object|null} Approval if valid, null otherwise
 */
export function checkApproval(server, tool, args) {
  const approvals = loadApprovals();
  const now = Date.now();

  for (const [code, request] of Object.entries(approvals.approvals)) {
    if (request.status !== 'approved') continue;
    if (request.expires_timestamp < now) continue;
    if (request.server !== server) continue;
    if (request.tool !== tool) continue;

    // Found a valid approval - consume it (one-time use)
    delete approvals.approvals[code];
    saveApprovals(approvals);

    return request;
  }

  return null;
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

  // Constants
  PROTECTION_KEY_PATH,
  PROTECTED_ACTIONS_PATH,
  APPROVALS_PATH,
  TOKEN_EXPIRY_MS,
};
