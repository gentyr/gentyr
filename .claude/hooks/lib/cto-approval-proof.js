/**
 * Shared module: CTO release approval cryptographic proof.
 *
 * Verifies that a CTO's verbatim approval quote exists in a session JSONL,
 * computes HMAC-SHA256 proof binding the quote to the release and session,
 * and provides verification utilities for the proof chain.
 *
 * Security model:
 *  - HMAC signed with `.claude/protection-key` (same key as bypass approval)
 *  - Domain separator `cto-release-approval` prevents cross-context replay
 *  - SHA-256 file hash binds the proof to the exact JSONL file contents
 *  - Constant-time comparison prevents timing attacks
 *  - G001 fail-closed: missing protection-key blocks proof creation
 *
 * @module cto-approval-proof
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const DOMAIN_SEPARATOR = 'cto-release-approval';

// ============================================================================
// Protection Key
// ============================================================================

/**
 * Load the protection key from .claude/protection-key.
 * @param {string} projectDir
 * @returns {string|null} Base64-encoded key, or null if missing/empty.
 */
export function loadProtectionKey(projectDir) {
  try {
    const keyPath = path.join(projectDir, '.claude', 'protection-key');
    if (!fs.existsSync(keyPath)) return null;
    const key = fs.readFileSync(keyPath, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

// ============================================================================
// File Hashing
// ============================================================================

/**
 * Compute SHA-256 hex hash of a file's contents.
 * @param {string} filePath
 * @returns {string} Hex-encoded SHA-256 hash.
 */
export function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ============================================================================
// HMAC Proof
// ============================================================================

/**
 * Compute HMAC-SHA256 approval proof.
 * Fields are pipe-delimited with domain separator to prevent cross-context replay.
 *
 * @param {string} keyBase64 - Base64-encoded protection key.
 * @param {string} releaseId
 * @param {string} sessionId
 * @param {string} approvalText - Verbatim CTO quote.
 * @param {string} fileHash - SHA-256 of the session JSONL.
 * @returns {string} Hex-encoded HMAC.
 */
export function computeApprovalHmac(keyBase64, releaseId, sessionId, approvalText, fileHash) {
  const keyBuffer = Buffer.from(keyBase64, 'base64');
  return crypto
    .createHmac('sha256', keyBuffer)
    .update([releaseId, sessionId, approvalText, fileHash, DOMAIN_SEPARATOR].join('|'))
    .digest('hex');
}

/**
 * Verify an HMAC approval proof using constant-time comparison.
 *
 * @param {string} keyBase64 - Base64-encoded protection key.
 * @param {{ release_id: string, session_id: string, approval_text: string, session_file_hash: string, hmac: string }} proof
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyApprovalHmac(keyBase64, proof) {
  if (!proof || !proof.release_id || !proof.session_id || !proof.approval_text || !proof.session_file_hash || !proof.hmac) {
    return { valid: false, reason: 'Proof object missing required fields' };
  }

  const expected = computeApprovalHmac(
    keyBase64, proof.release_id, proof.session_id, proof.approval_text, proof.session_file_hash,
  );

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(proof.hmac, 'hex');

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'HMAC length mismatch' };
  }

  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'HMAC verification failed — proof is invalid or tampered' };
  }

  return { valid: true };
}

// ============================================================================
// Quote Verification in JSONL
// ============================================================================

/**
 * Verify that a verbatim quote exists in a CTO-originated message within a JSONL session file.
 * Only matches text the CTO actually typed or selected — NOT agent-generated content.
 *
 * Matched sources (all require entry.type === 'human' or 'user'):
 *  1. Raw user messages: direct CTO typing (text blocks or string content)
 *  2. AskUserQuestion responses: CTO selecting an option (toolUseResult.answers values)
 *  3. AskUserQuestion tool_result content string (contains the user's answer text)
 *
 * NOT matched (security):
 *  - Assistant messages (type === 'assistant') — agent-generated
 *  - Tool results from non-AskUserQuestion tools — contain agent/system output
 *  - System messages — injected by hooks, not CTO-typed
 *
 * @param {string} jsonlPath - Path to the session JSONL file.
 * @param {string} quote - The exact text to find (substring match within a CTO message).
 * @returns {Promise<{ found: boolean, lineNumber?: number, timestamp?: string, lineContent?: string, source?: string }>}
 */
export async function verifyQuoteInJsonl(jsonlPath, quote) {
  if (!fs.existsSync(jsonlPath)) {
    return { found: false };
  }

  const fileStream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      // Only check human/user message types (Claude Code JSONL format)
      const type = entry.type || entry.role;
      if (type !== 'human' && type !== 'user') continue;

      const contentArr = entry.message?.content || entry.content;

      // Source 1: Check AskUserQuestion answers (toolUseResult.answers)
      // This is the most reliable source — contains the exact option text the CTO selected
      if (entry.toolUseResult?.answers) {
        const answers = entry.toolUseResult.answers;
        const answerValues = Object.values(answers);
        for (const answer of answerValues) {
          if (typeof answer === 'string' && answer.includes(quote)) {
            rl.close();
            fileStream.destroy();
            return {
              found: true,
              lineNumber,
              timestamp: entry.timestamp || entry.created_at || null,
              lineContent: line.slice(0, 2000),
              source: 'ask_user_question_answer',
            };
          }
        }
      }

      // Source 2: Raw user messages (direct CTO typing)
      // Only extract from text blocks and plain string content — NOT from tool_result blocks
      // (tool_result blocks contain agent output being returned, not CTO-typed text)
      let text = '';
      if (typeof contentArr === 'string') {
        text = contentArr;
      } else if (Array.isArray(contentArr)) {
        // Only text blocks (type === 'text') represent CTO-typed content
        // tool_result blocks are agent responses being relayed — skip them for raw match
        const textBlocks = contentArr.filter(b => b.type === 'text');
        if (textBlocks.length > 0) {
          text = textBlocks.map(b => b.text).join('\n');
        } else {
          // Source 3: AskUserQuestion tool_result content string
          // When the user responds to AskUserQuestion, the response comes as:
          // content: [{ type: "tool_result", content: "User has answered... \"=<answer>\"..." }]
          // Only match these if they look like AskUserQuestion responses
          for (const block of contentArr) {
            if (block.type === 'tool_result' && typeof block.content === 'string') {
              // AskUserQuestion responses start with "User has answered your questions:"
              if (block.content.startsWith('User has answered')) {
                if (block.content.includes(quote)) {
                  rl.close();
                  fileStream.destroy();
                  return {
                    found: true,
                    lineNumber,
                    timestamp: entry.timestamp || entry.created_at || null,
                    lineContent: line.slice(0, 2000),
                    source: 'ask_user_question_tool_result',
                  };
                }
              }
            }
          }
        }
      }

      if (text && text.includes(quote)) {
        rl.close();
        fileStream.destroy();
        return {
          found: true,
          lineNumber,
          timestamp: entry.timestamp || entry.created_at || null,
          lineContent: line.slice(0, 2000),
          source: 'user_message',
        };
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { found: false };
}

// ============================================================================
// Session JSONL Discovery
// ============================================================================

/**
 * Find the current interactive CTO session's JSONL file.
 *
 * Strategy:
 *  1. Check CLAUDE_SESSION_ID env var for direct lookup
 *  2. Fall back to most-recently-modified JSONL in the project's session directory
 *
 * @param {string} projectDir
 * @returns {{ sessionId: string, jsonlPath: string } | null}
 */
export function findCurrentSessionJsonl(projectDir) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  // Derive the encoded project path for Claude's session directory
  // Must match the canonical encoding used everywhere: replace ALL non-alphanumeric chars with dashes
  const encodedPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(homeDir, '.claude', 'projects', encodedPath);

  // Strategy 1: Direct lookup via CLAUDE_SESSION_ID
  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (sessionId) {
    const directPath = path.join(sessionDir, `${sessionId}.jsonl`);
    if (fs.existsSync(directPath)) {
      return { sessionId, jsonlPath: directPath };
    }
  }

  // Strategy 2: Most recently modified JSONL (interactive CTO session)
  if (!fs.existsSync(sessionDir)) return null;

  let bestFile = null;
  let bestMtime = 0;

  try {
    for (const file of fs.readdirSync(sessionDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(sessionDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > bestMtime) {
          // Skip very small files (likely empty/aborted sessions)
          if (stat.size < 100) continue;

          // Check first 2KB for automation markers — skip non-CTO sessions
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(2048);
          const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
          fs.closeSync(fd);
          const head = buf.toString('utf8', 0, bytesRead);
          if (head.includes('[Automation]') || head.includes('[Task]') || head.includes('[AGENT:')) {
            continue;
          }

          bestMtime = stat.mtimeMs;
          bestFile = filePath;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    return null;
  }

  if (!bestFile) return null;

  const id = path.basename(bestFile, '.jsonl');
  return { sessionId: id, jsonlPath: bestFile };
}
