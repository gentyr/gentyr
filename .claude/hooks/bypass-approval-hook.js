#!/usr/bin/env node
/**
 * Bypass Approval Hook (UserPromptSubmit)
 *
 * Watches for CTO bypass approval messages in the format:
 *   APPROVE BYPASS <6-char-code>
 *
 * When detected, validates the code exists in pending bypass requests
 * and writes an approval token that execute_bypass can verify.
 *
 * This ensures only the CTO (human user) can approve bypasses by typing
 * the approval phrase - agents cannot trigger UserPromptSubmit hooks.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const APPROVAL_TOKEN_FILE = path.join(PROJECT_DIR, '.claude', 'bypass-approval-token.json');
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');

// Token expires after 5 minutes
const TOKEN_EXPIRY_MS = 5 * 60 * 1000;

// Pattern to match: APPROVE BYPASS XXXXXX (6 alphanumeric chars)
const APPROVAL_PATTERN = /APPROVE\s+BYPASS\s+([A-Z0-9]{6})/i;

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

/**
 * Try to import better-sqlite3 and check if bypass code is valid
 */
async function validateBypassCode(code) {
  try {
    const Database = (await import('better-sqlite3')).default;

    if (!fs.existsSync(DEPUTY_CTO_DB)) {
      return { valid: false, reason: 'Database not found' };
    }

    const db = new Database(DEPUTY_CTO_DB, { readonly: true });

    // Look for pending bypass-request with this code in context field
    const question = db.prepare(`
      SELECT id, title, created_at FROM questions
      WHERE type = 'bypass-request'
      AND status = 'pending'
      AND context = ?
    `).get(code);

    db.close();

    if (!question) {
      return { valid: false, reason: 'No pending bypass request with this code' };
    }

    return {
      valid: true,
      request_id: question.id,
      title: question.title,
      created_at: question.created_at
    };
  } catch (err) {
    return { valid: false, reason: `Database error: ${err.message}` };
  }
}

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

/**
 * Write approval token with HMAC signature to prevent forgery.
 *
 * SECURITY FIX (H1): Token now includes HMAC-SHA256 signature computed from
 * code, request_id, and expires_timestamp using the protection key.
 * block-no-verify.js verifies this signature before accepting the token.
 */
function writeApprovalToken(code, requestId, userMessage) {
  const now = Date.now();
  const expiresTimestamp = now + TOKEN_EXPIRY_MS;

  // Compute HMAC signature to prevent agent forgery
  const key = loadProtectionKey();
  const hmac = key ? computeHmac(key, code, requestId, String(expiresTimestamp), 'bypass-approved') : undefined;

  const token = {
    code,
    request_id: requestId,
    user_message: userMessage,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(expiresTimestamp).toISOString(),
    expires_timestamp: expiresTimestamp,
    ...(hmac && { hmac }),
  };

  try {
    fs.writeFileSync(APPROVAL_TOKEN_FILE, JSON.stringify(token, null, 2));
    return true;
  } catch (err) {
    console.error(`[bypass-approval] Failed to write token: ${err.message}`);
    return false;
  }
}

/**
 * Main entry point
 */
async function main() {
  const userMessage = await readUserMessage();

  if (!userMessage) {
    // No message, nothing to do
    process.exit(0);
  }

  // Check if message matches approval pattern
  const match = userMessage.match(APPROVAL_PATTERN);

  if (!match) {
    // Not an approval message, pass through silently
    process.exit(0);
  }

  const code = match[1].toUpperCase();

  // Validate the bypass code
  const validation = await validateBypassCode(code);

  if (!validation.valid) {
    console.error(`[bypass-approval] Invalid bypass code "${code}": ${validation.reason}`);
    process.exit(0); // Don't block the user's message, just log warning
  }

  // Write approval token
  const written = writeApprovalToken(code, validation.request_id, userMessage);

  if (written) {
    console.error(`[bypass-approval] Bypass approved for code ${code}`);
    console.error(`[bypass-approval] Request: ${validation.title}`);
    console.error(`[bypass-approval] Token valid for 5 minutes`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[bypass-approval] Error: ${err.message}`);
  process.exit(0); // Don't block on errors
});
