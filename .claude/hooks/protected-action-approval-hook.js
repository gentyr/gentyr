#!/usr/bin/env node
/**
 * Protected Action Approval Hook (UserPromptSubmit)
 *
 * Watches for CTO approval messages in the format:
 *   APPROVE <PHRASE> <6-char-code>
 *
 * Examples:
 *   APPROVE PROD A7X9K2
 *   APPROVE PAYMENT B3C4D5
 *   APPROVE EMAIL X7Y8Z9
 *
 * When detected, validates the code exists in pending approval requests
 * and marks the request as approved.
 *
 * This ensures only the CTO (human user) can approve protected actions
 * by typing the approval phrase - agents cannot trigger UserPromptSubmit hooks.
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const PROTECTED_ACTIONS_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
const APPROVALS_PATH = path.join(PROJECT_DIR, '.claude', 'protected-action-approvals.json');

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
  if (!config || !config.servers) {
    return [];
  }
  return Object.values(config.servers)
    .map(s => s.phrase)
    .filter(Boolean)
    .map(p => p.toUpperCase());
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
  fs.writeFileSync(APPROVALS_PATH, JSON.stringify(approvals, null, 2));
}

/**
 * Validate and approve a request
 * @param {string} phrase - The approval phrase (e.g., "PROD")
 * @param {string} code - The 6-character code
 * @returns {object} Validation result
 */
function validateAndApprove(phrase, code) {
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

  // Mark as approved
  request.status = 'approved';
  request.approved_at = new Date().toISOString();
  request.approved_timestamp = Date.now();
  saveApprovals(approvals);

  return {
    valid: true,
    server: request.server,
    tool: request.tool,
    code: normalizedCode,
  };
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

  // Validate and approve the request
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

main().catch((err) => {
  console.error(`[protected-action-approval] Error: ${err.message}`);
  process.exit(0); // Don't block on errors
});
