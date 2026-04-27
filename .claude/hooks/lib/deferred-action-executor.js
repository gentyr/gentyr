/**
 * Deferred Protected Action Executor
 *
 * Executes approved deferred protected actions by calling the MCP shared
 * daemon's HTTP transport directly. This allows protected actions to be
 * executed after CTO approval without requiring the original agent session.
 *
 * Supports Tier 1 servers (hosted in the shared daemon on port 18090).
 * Tier 2 servers are not supported — they require per-session stdio.
 *
 * Security:
 * - HMAC signatures are verified before execution
 * - Actions execute exactly the args that were approved (args-hash bound)
 * - Atomic status transitions prevent double-execution
 * - Fail-closed: daemon unreachable = action fails, not silently skipped
 *
 * @module lib/deferred-action-executor
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Import TIER1_SERVERS list from shared config
// Inline the list to avoid ESM/CJS import issues in hook context
const TIER1_SERVERS = [
  'github', 'cloudflare', 'supabase', 'vercel', 'render',
  'codecov', 'resend', 'elastic-logs', 'onepassword', 'secret-sync',
  'feedback-explorer', 'cto-report', 'specs-browser', 'setup-helper', 'show',
];

const MCP_DAEMON_PORT = 18090;
const MCP_DAEMON_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 30000;

// ============================================================================
// MCP HTTP Transport
// ============================================================================

/**
 * Make an HTTP POST request to the MCP daemon.
 * @param {string} serverPath - URL path (e.g., /mcp/vercel)
 * @param {object} body - JSON-RPC request body
 * @param {object} [headers] - Additional headers
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
function httpPost(serverPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: MCP_DAEMON_HOST,
      port: MCP_DAEMON_PORT,
      path: serverPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: responseBody,
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy(new Error('MCP daemon request timed out'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * Check if the MCP daemon is healthy.
 * Uses HTTP GET (the /health endpoint only handles GET requests).
 * @returns {Promise<boolean>}
 */
export async function isDaemonHealthy() {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: MCP_DAEMON_HOST,
      port: MCP_DAEMON_PORT,
      path: '/health',
      timeout: 5000,
    }, (res) => {
      // Consume response body
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Check if a server is a Tier 1 server (hosted in the shared daemon).
 * @param {string} server - MCP server name
 * @returns {boolean}
 */
export function isTier1Server(server) {
  return TIER1_SERVERS.includes(server);
}

/**
 * Execute an MCP tool call via the shared daemon HTTP transport.
 *
 * Performs the full MCP session lifecycle:
 * 1. Initialize session (get session ID)
 * 2. Call the tool with provided arguments
 * 3. Return the result
 *
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments
 * @returns {Promise<{success: boolean, result?: object, error?: string}>}
 */
export async function executeMcpTool(server, tool, args) {
  if (!isTier1Server(server)) {
    return {
      success: false,
      error: `Server "${server}" is not a Tier 1 server. Only Tier 1 servers can be executed via deferred actions.`,
    };
  }

  const serverPath = `/mcp/${server}`;

  // Step 1: Initialize MCP session
  let sessionId;
  try {
    const initRes = await httpPost(serverPath, {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'gentyr-deferred-executor',
          version: '1.0.0',
        },
      },
      id: 1,
    });

    if (initRes.status !== 200) {
      return {
        success: false,
        error: `MCP daemon returned ${initRes.status} during initialization: ${initRes.body}`,
      };
    }

    sessionId = initRes.headers['mcp-session-id'];
    const initBody = JSON.parse(initRes.body);
    if (initBody.error) {
      return {
        success: false,
        error: `MCP initialization error: ${JSON.stringify(initBody.error)}`,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Failed to connect to MCP daemon at ${MCP_DAEMON_HOST}:${MCP_DAEMON_PORT}: ${err.message}`,
    };
  }

  // Step 2: Send initialized notification
  try {
    await httpPost(serverPath, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, sessionId ? { 'Mcp-Session-Id': sessionId } : {});
  } catch {
    // Non-fatal — some servers don't require the initialized notification
  }

  // Step 3: Call the tool
  try {
    const callRes = await httpPost(serverPath, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: tool,
        arguments: args,
      },
      id: 2,
    }, sessionId ? { 'Mcp-Session-Id': sessionId } : {});

    if (callRes.status !== 200) {
      return {
        success: false,
        error: `MCP daemon returned ${callRes.status} during tool call: ${callRes.body}`,
      };
    }

    const callBody = JSON.parse(callRes.body);
    if (callBody.error) {
      return {
        success: false,
        error: `MCP tool error: ${JSON.stringify(callBody.error)}`,
      };
    }

    return {
      success: true,
      result: callBody.result,
    };
  } catch (err) {
    return {
      success: false,
      error: `MCP tool call failed: ${err.message}`,
    };
  }
}

// ============================================================================
// HMAC Verification (shared with protected-action-gate)
// ============================================================================

/**
 * Compute HMAC-SHA256 over pipe-delimited fields.
 * Must match the computation in protected-action-gate.js
 * @param {string} keyBase64 - Base64-encoded protection key
 * @param {...string} fields - Fields to include
 * @returns {string} Hex-encoded HMAC
 */
function computeHmac(keyBase64, ...fields) {
  const keyBuffer = Buffer.from(keyBase64, 'base64');
  return crypto.createHmac('sha256', keyBuffer)
    .update(fields.join('|'))
    .digest('hex');
}

/**
 * Load the protection key.
 * @returns {string|null} Base64-encoded key or null
 */
function loadProtectionKey() {
  try {
    const keyPath = path.join(PROJECT_DIR, '.claude', 'protection-key');
    if (!fs.existsSync(keyPath)) return null;
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Constant-time HMAC comparison to prevent timing attacks.
 * Follows the pattern from bypass-approval-token.js.
 * @param {string} actual - HMAC hex string from the record
 * @param {string} expected - Freshly computed HMAC hex string
 * @returns {boolean}
 */
function hmacEqual(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuf = Buffer.from(actual, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Verify the HMAC chain of a deferred action before execution.
 * Checks both the pending_hmac (created by the gate hook) and
 * the approved_hmac (created by the approval hook).
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param {object} action - Deferred action record from DB
 * @returns {{valid: boolean, reason?: string}}
 */
export function verifyActionHmac(action) {
  const key = loadProtectionKey();
  if (!key) {
    return { valid: false, reason: 'Protection key missing — cannot verify HMAC (G001 fail-closed)' };
  }

  // Verify pending_hmac: was this request created by the gate hook?
  // Domain separator: 'deferred-pending' to distinguish from standard approvals
  const expectedPendingHmac = computeHmac(
    key,
    action.code,
    action.server,
    action.tool,
    action.args_hash,
    'deferred-pending',
  );
  if (!hmacEqual(action.pending_hmac, expectedPendingHmac)) {
    return { valid: false, reason: 'Invalid pending_hmac — possible forgery' };
  }

  // Verify approved_hmac: was this approval created by the approval hook?
  if (!action.approved_hmac) {
    return { valid: false, reason: 'Missing approved_hmac — action not yet approved' };
  }
  const expectedApprovedHmac = computeHmac(
    key,
    action.code,
    action.server,
    action.tool,
    action.args_hash,
    'deferred-approved',
  );
  if (!hmacEqual(action.approved_hmac, expectedApprovedHmac)) {
    return { valid: false, reason: 'Invalid approved_hmac — possible forgery' };
  }

  return { valid: true };
}

/**
 * Compute the pending HMAC for a new deferred action.
 * Uses 'deferred-pending' domain separator.
 * @param {string} code
 * @param {string} server
 * @param {string} tool
 * @param {string} argsHash
 * @returns {string|null} HMAC hex or null if key missing
 */
export function computePendingHmac(code, server, tool, argsHash) {
  const key = loadProtectionKey();
  if (!key) return null;
  return computeHmac(key, code, server, tool, argsHash, 'deferred-pending');
}

/**
 * Compute the approved HMAC for an approved deferred action.
 * Uses 'deferred-approved' domain separator.
 * @param {string} code
 * @param {string} server
 * @param {string} tool
 * @param {string} argsHash
 * @returns {string|null} HMAC hex or null if key missing
 */
export function computeApprovedHmac(code, server, tool, argsHash) {
  const key = loadProtectionKey();
  if (!key) return null;
  return computeHmac(key, code, server, tool, argsHash, 'deferred-approved');
}

// ============================================================================
// Full Execution Pipeline
// ============================================================================

/**
 * Execute a deferred action end-to-end: verify HMAC, transition status,
 * call MCP tool, store result.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {object} action - Deferred action record
 * @returns {Promise<{success: boolean, result?: object, error?: string}>}
 */
export async function executeAction(db, action) {
  const dbMod = await import('./deferred-action-db.js');

  // Step 1: Verify HMAC integrity
  const hmacCheck = verifyActionHmac(action);
  if (!hmacCheck.valid) {
    dbMod.markFailed(db, action.id, `HMAC verification failed: ${hmacCheck.reason}`);
    return { success: false, error: hmacCheck.reason };
  }

  // Step 2: Atomically transition to 'executing' (prevents double-execution)
  if (!dbMod.markExecuting(db, action.id)) {
    return { success: false, error: 'Could not transition to executing — action may already be in progress' };
  }

  // Step 3: Parse args (stored as JSON string in DB, may already be parsed)
  let args = action.args;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch {
      dbMod.markFailed(db, action.id, 'Failed to parse action arguments');
      return { success: false, error: 'Failed to parse action arguments' };
    }
  }

  // Step 4: Execute the MCP tool call
  const result = await executeMcpTool(action.server, action.tool, args);

  // Step 5: Store result
  if (result.success) {
    dbMod.markCompleted(db, action.id, JSON.stringify(result.result));
  } else {
    dbMod.markFailed(db, action.id, result.error);
  }

  return result;
}
