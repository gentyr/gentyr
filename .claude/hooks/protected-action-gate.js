#!/usr/bin/env node
/**
 * PreToolUse Hook: Protected Action Gate
 *
 * Intercepts MCP tool calls and blocks protected actions that haven't
 * been approved by the CTO. When blocked, generates an approval code
 * that the CTO must type to authorize the action.
 *
 * Security Model:
 * - Agent cannot bypass: PreToolUse hooks run before tool execution
 * - Agent cannot forge approval: UserPromptSubmit = human keyboard only
 * - One-time codes: Each approval is tied to a specific request
 * - Time-limited: Codes expire after 5 minutes
 * - G001 Fail-Closed: If config is corrupted, all protected servers are blocked
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const PROTECTED_ACTIONS_PATH = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
const PROTECTION_KEY_PATH = path.join(PROJECT_DIR, '.claude', 'protection-key');

// PreToolUse hooks receive tool info via environment variables
const toolName = process.env.TOOL_NAME || '';
const toolInput = process.env.TOOL_INPUT || '{}';

// ============================================================================
// HMAC Signing (Fix 2: Anti-Forgery)
// ============================================================================

/**
 * Load the protection key for HMAC signing.
 * Returns null if key file doesn't exist (fail-closed handled by caller).
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

// ============================================================================
// MCP Tool Detection
// ============================================================================

/**
 * Parse MCP tool name into server and tool components
 * Format: mcp__servername__toolname
 * Server names use hyphens (not underscores), tool names use underscores.
 * @param {string} name - Full tool name
 * @returns {object|null} { server, tool } or null if not an MCP tool
 */
function parseMcpToolName(name) {
  // Server name: alphanumeric + hyphens (no underscores)
  // Tool name: alphanumeric + underscores + hyphens
  const match = name.match(/^mcp__([a-zA-Z0-9-]+)__([a-zA-Z0-9_-]+)$/);
  if (!match) {
    return null;
  }
  return {
    server: match[1],
    tool: match[2],
  };
}

// ============================================================================
// Protection Check
// ============================================================================

/**
 * Load protected actions configuration
 * @returns {object} Config object with 'servers' property, or object with 'error' flag
 */
function loadProtectedActions() {
  try {
    if (!fs.existsSync(PROTECTED_ACTIONS_PATH)) {
      // G001 Fail-Closed: Config missing = block all MCP actions
      // An adversarial agent could delete this file to bypass protections (A4/C5)
      return { servers: {}, notConfigured: true };
    }
    const config = JSON.parse(fs.readFileSync(PROTECTED_ACTIONS_PATH, 'utf8'));
    if (!config.servers) {
      config.servers = {};
    }
    return config;
  } catch (err) {
    // G001: Fail closed - if we can't read config, assume ALL MCP actions are blocked
    // This prevents an adversary from corrupting the config to bypass protections
    console.error(`[protected-action-gate] G001 FAIL-CLOSED: Config error, blocking all MCP actions: ${err.message}`);
    return { error: true, message: err.message };
  }
}

/**
 * Check if a server:tool is protected
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} config - Protected actions config
 * @returns {object|null} Protection config or null if not protected
 */
function getProtection(server, tool, config) {
  if (!config || !config.servers || !config.servers[server]) {
    return null;
  }

  const serverConfig = config.servers[server];

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
// Approval Check
// ============================================================================

const APPROVALS_PATH = path.join(PROJECT_DIR, '.claude', 'protected-action-approvals.json');

const LOCK_PATH = APPROVALS_PATH + '.lock';

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
      } catch { /* lock file gone, retry */ }

      // Exponential backoff
      const delay = baseDelay * Math.pow(2, i);
      const start = Date.now();
      while (Date.now() - start < delay) { /* busy wait */ }
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
  } catch { /* already released */ }
}

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
 * Check if there's a valid approval for this action.
 * Verifies HMAC signatures to prevent agent forgery (Fix 2).
 * Uses file locking to prevent TOCTOU race conditions on approval consumption.
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments (used to verify approval is scoped to these exact args)
 * @returns {object|null} Approval if valid, null otherwise
 */
function checkApproval(server, tool, args) {
  // Acquire lock to prevent TOCTOU race: two concurrent checks consuming same approval
  if (!acquireLock()) {
    console.error('[protected-action-gate] G001 FAIL-CLOSED: Could not acquire approvals lock. Blocking action.');
    return null;
  }

  try {
    const approvals = loadApprovals();
    const now = Date.now();
    const key = loadProtectionKey();
    let dirty = false;

    // Hash the current call's arguments to verify they match the approved args
    const argsHash = crypto.createHash('sha256')
      .update(JSON.stringify(args || {}))
      .digest('hex');

    for (const [code, request] of Object.entries(approvals.approvals)) {
      if (request.status !== 'approved') continue;
      if (request.expires_timestamp < now) continue;
      if (request.server !== server) continue;
      if (request.tool !== tool) continue;

      // Verify args match what was approved (prevents bait-and-switch attack)
      if (request.argsHash && request.argsHash !== argsHash) {
        continue; // Args don't match the approved request
      }

      // HMAC verification (Fix 2): Verify signatures to prevent agent forgery
      // argsHash is included in HMAC to bind approval to specific arguments
      if (key) {
        // Verify pending_hmac (was this request created by this hook with these args?)
        const expectedPendingHmac = computeHmac(key, code, server, tool, request.argsHash || argsHash, String(request.expires_timestamp));
        if (request.pending_hmac !== expectedPendingHmac) {
          // Forged pending request - delete it
          console.error(`[protected-action-gate] FORGERY DETECTED: Invalid pending_hmac for ${code}. Deleting.`);
          delete approvals.approvals[code];
          dirty = true;
          continue;
        }

        // Verify approved_hmac (was this approval created by the approval hook?)
        const expectedApprovedHmac = computeHmac(key, code, server, tool, 'approved', request.argsHash || argsHash, String(request.expires_timestamp));
        if (request.approved_hmac !== expectedApprovedHmac) {
          // Forged approval - delete it
          console.error(`[protected-action-gate] FORGERY DETECTED: Invalid approved_hmac for ${code}. Deleting.`);
          delete approvals.approvals[code];
          dirty = true;
          continue;
        }
      } else if (request.pending_hmac || request.approved_hmac) {
        // G001 Fail-Closed: Request has HMAC fields but we can't verify them
        // (protection key missing/unreadable). Reject rather than skip verification.
        console.error(`[protected-action-gate] G001 FAIL-CLOSED: Cannot verify HMAC for ${code} (protection key missing). Skipping.`);
        continue;
      }

      // Found a valid, HMAC-verified approval - consume it (one-time use)
      delete approvals.approvals[code];
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
 * Generate a 6-character alphanumeric approval code using crypto-secure randomness
 * Excludes confusing characters: 0/O, 1/I/L
 */
function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomBytes[i] % chars.length);
  }
  return code;
}

/**
 * Create a pending approval request with HMAC signing (Fix 2).
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments
 * @param {string} phrase - Approval phrase
 * @param {object} [options] - Additional options
 * @param {string} [options.approvalMode] - 'cto' (default) or 'deputy-cto'
 * @returns {object} Request details
 */
function createRequest(server, tool, args, phrase, options = {}) {
  const code = generateCode();
  const now = Date.now();
  const expiryMs = 5 * 60 * 1000; // 5 minutes
  const expiresTimestamp = now + expiryMs;

  // Hash the args to bind the approval to these specific arguments (prevents bait-and-switch)
  const argsHash = crypto.createHash('sha256')
    .update(JSON.stringify(args || {}))
    .digest('hex');

  // Compute HMAC for pending request (prevents agent forgery)
  // Includes argsHash so approval is bound to exact arguments shown to CTO
  const key = loadProtectionKey();
  const pendingHmac = key ? computeHmac(key, code, server, tool, argsHash, String(expiresTimestamp)) : undefined;

  // Acquire lock for atomic read-modify-write
  if (!acquireLock()) {
    console.error('[protected-action-gate] Warning: Could not acquire lock for createRequest. Proceeding without lock.');
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
    for (const [key, val] of Object.entries(approvals.approvals)) {
      if (val.expires_timestamp > now) {
        validApprovals[key] = val;
      }
    }
    approvals.approvals = validApprovals;

    saveApprovals(approvals);
  } finally {
    releaseLock();
  }

  return {
    code,
    phrase,
    message: `${phrase} ${code}`,
  };
}

// ============================================================================
// Main
// ============================================================================

function main() {
  // Only check MCP tool calls
  const mcpInfo = parseMcpToolName(toolName);
  if (!mcpInfo) {
    // Not an MCP tool, allow
    process.exit(0);
  }

  // Load config
  const config = loadProtectedActions();

  // G001: If config is corrupted/unreadable, block ALL MCP actions
  if (config.error) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  G001 FAIL-CLOSED: Protected actions config is corrupted');
    console.error('');
    console.error(`  Error: ${config.message}`);
    console.error('');
    console.error('  ALL MCP actions are blocked until config is fixed.');
    console.error('  Fix the config file at: .claude/hooks/protected-actions.json');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  // G001 Fail-Closed: If config file is missing, block ALL MCP actions
  // This prevents attack A4/C5: agent deletes/moves config to bypass protections
  if (config.notConfigured) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  G001 FAIL-CLOSED: Protected actions config not found');
    console.error('');
    console.error('  File: .claude/hooks/protected-actions.json');
    console.error('  ALL MCP actions are blocked until config is restored.');
    console.error('  Run: setup.sh --path <project> to reinstall GENTYR');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  // Check if this action is protected
  const protection = getProtection(mcpInfo.server, mcpInfo.tool, config);
  if (!protection) {
    // Not a protected tool — but is this a known server? (Fix 3: MCP Server Allowlist)
    // 1. Server IS in config.servers but this specific tool isn't protected -> allow (unprotected tool on known server)
    if (config.servers[mcpInfo.server]) {
      process.exit(0);
    }

    // 2. Server IS in allowedUnprotectedServers -> allow (framework/internal server)
    const allowedServers = config.allowedUnprotectedServers || [];
    if (allowedServers.includes(mcpInfo.server)) {
      process.exit(0);
    }

    // 3. Unknown server -> BLOCK (prevents MCP server aliasing attack C2)
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  BLOCKED: Unrecognized MCP Server');
    console.error('');
    console.error(`  Server: ${mcpInfo.server}`);
    console.error(`  Tool:   ${mcpInfo.tool}`);
    console.error('');
    console.error('  This MCP server is not in the protected-actions.json config.');
    console.error('  To allow this server, add it to "allowedUnprotectedServers"');
    console.error('  or "servers" in .claude/hooks/protected-actions.json');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  // Parse tool arguments
  let args = {};
  try {
    args = JSON.parse(toolInput);
  } catch (err) {
    // Can't parse args, but still need to check protection
  }

  // G001 Fail-Closed: If protection key is missing and we have protected actions,
  // we cannot verify HMAC signatures. Block the action rather than allowing unsigned approvals.
  const protectionKey = loadProtectionKey();
  if (!protectionKey) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  G001 FAIL-CLOSED: Protection key missing');
    console.error('');
    console.error('  File: .claude/protection-key');
    console.error('  Cannot verify approval signatures without protection key.');
    console.error('  Run: setup.sh --path <project> to reinstall GENTYR');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }

  // Check for valid approval (HMAC-verified, args-scoped)
  const approval = checkApproval(mcpInfo.server, mcpInfo.tool, args);
  if (approval) {
    // Has valid, HMAC-verified approval, allow
    console.error(`[protected-action-gate] Approval verified for ${mcpInfo.server}:${mcpInfo.tool}`);
    process.exit(0);
  }

  // Determine approval mode from protection config
  const approvalMode = protection.protection || 'approval-only';
  const isDeputyCtoMode = approvalMode === 'deputy-cto-approval';

  // No approval - block and request one
  const request = createRequest(mcpInfo.server, mcpInfo.tool, args, protection.phrase, {
    approvalMode: isDeputyCtoMode ? 'deputy-cto' : 'cto',
  });

  // Output block message
  console.error('');
  console.error('══════════════════════════════════════════════════════════════════════');
  if (isDeputyCtoMode) {
    console.error('  PROTECTED ACTION BLOCKED: Deputy-CTO Approval Required');
  } else {
    console.error('  PROTECTED ACTION BLOCKED: CTO Approval Required');
  }
  console.error('');
  console.error(`  Server: ${mcpInfo.server}`);
  console.error(`  Tool:   ${mcpInfo.tool}`);
  console.error('');
  if (Object.keys(args).length > 0) {
    console.error('  Arguments:');
    const argsStr = JSON.stringify(args, null, 2).split('\n');
    argsStr.forEach(line => console.error(`    ${line}`));
    console.error('');
  }
  console.error('  ─────────────────────────────────────────────────────────────────────');
  console.error('');
  if (isDeputyCtoMode) {
    console.error(`  Request code: ${request.code}`);
    console.error('');
    console.error('  Submit a report to deputy-cto for triage:');
    console.error(`    mcp__agent-reports__report_to_deputy_cto`);
    console.error(`    title: "Protected Action Request: ${mcpInfo.server}.${mcpInfo.tool}"`);
    console.error(`    Include code ${request.code} in summary.`);
    console.error('');
    console.error('  Deputy-CTO can approve, deny, or escalate to CTO.');
    console.error('  For CTO escalation, CTO must type:');
    console.error(`      ${request.message}`);
  } else {
    console.error(`  To approve, CTO must type exactly:`);
    console.error('');
    console.error(`      ${request.message}`);
  }
  console.error('');
  console.error('  This code expires in 5 minutes.');
  console.error('  After approval, retry this action.');
  console.error('══════════════════════════════════════════════════════════════════════');
  console.error('');

  // Exit with error to block the tool call
  process.exit(1);
}

main();
