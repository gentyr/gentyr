#!/usr/bin/env node
/**
 * PreToolUse Hook: Protected Action Gate
 *
 * Intercepts MCP tool calls and blocks protected actions that haven't
 * been approved by the CTO. When blocked, captures the full tool call
 * as a deferred action in bypass-requests.db.
 *
 * Unified flow (Phase 3 of Unified CTO Authorization System):
 * - Both interactive and spawned sessions create deferred actions on block
 * - Interactive sessions: agent presents to CTO, CTO approves via record_cto_decision
 * - Spawned sessions: agent calls submit_bypass_request and exits
 * - The deferred action auto-executes after CTO approval + audit pass
 * - The agent NEVER retries — the system fires the tool call autonomously
 *
 * Security Model:
 * - Agent cannot bypass: PreToolUse hooks run before tool execution
 * - HMAC-signed deferred actions prevent forgery
 * - Args-hash binding prevents bait-and-switch
 * - G001 Fail-Closed: If config is corrupted, all protected servers are blocked
 *
 * DEPRECATED: protected-action-approvals.json is no longer read or written.
 * All approvals now flow through deferred_actions table in bypass-requests.db.
 *
 * DEPRECATED: The pre-approved bypass mechanism (request_preapproved_bypass,
 * activate_preapproved_bypass on the deputy-cto server) is no longer consumed
 * by this hook. The old "burst-use" pre-approval Pass 2 in checkApproval() has
 * been removed. These MCP tools should be deprecated in a future phase.
 *
 * SECURITY: This file should be root-owned via protect-framework.sh
 *
 * @version 3.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
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
// Blocked Action Audit Log (G024)
// ============================================================================

const MAX_AUDIT_ENTRIES = 500;
const blockedActionsLog = [];

function logBlockedAction(server, tool, reason) {
  if (blockedActionsLog.length >= MAX_AUDIT_ENTRIES) return;
  blockedActionsLog.push({
    server,
    tool,
    reason,
    timestamp: new Date().toISOString(),
  });
}

function blockAndExit() {
  if (blockedActionsLog.length > 0) {
    console.error(JSON.stringify({
      type: 'blocked_actions_audit',
      count: blockedActionsLog.length,
      entries: blockedActionsLog,
    }));
  }
  process.exit(1);
}

// ============================================================================
// HMAC Support
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
  // Tool name: must start with alphanumeric, with only single _ or - separators between
  // alphanumeric segments. Double underscores (__) are rejected because __ is the
  // delimiter between server and tool name in MCP naming convention.
  const match = name.match(/^mcp__([a-zA-Z0-9-]+)__([a-zA-Z0-9]+(?:[_-][a-zA-Z0-9]+)*)$/);
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
// Branch-Aware Protection
// ============================================================================

/**
 * Detect the current git branch.
 * Checks GENTYR_CURRENT_BRANCH env var first (for testing), then falls back
 * to `git branch --show-current`. Returns null if detection fails.
 * @returns {string|null} Branch name or null on failure
 */
function detectCurrentBranch() {
  // Allow test injection via environment variable
  if (process.env.GENTYR_CURRENT_BRANCH) {
    return process.env.GENTYR_CURRENT_BRANCH;
  }

  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // An empty string means detached HEAD — treat as detection failure
    return branch || null;
  } catch (err) {
    console.error('[protected-action-gate] Warning:', err.message);
    return null;
  }
}

/**
 * Check whether a branch name matches an environment's branchPattern.
 * Supports:
 *   - Exact match: "main" matches "main"
 *   - Glob prefix: "preview/*" matches any branch starting with "preview/"
 * @param {string} branch - Current branch name
 * @param {string} pattern - Branch pattern from environments config
 * @returns {boolean}
 */
function branchMatchesPattern(branch, pattern) {
  if (pattern.endsWith('/*')) {
    // Glob prefix match: strip the "*" and check startsWith the remaining prefix
    const prefix = pattern.slice(0, -1); // e.g. "preview/*" → "preview/"
    return branch.startsWith(prefix);
  }
  // Exact match
  return branch === pattern;
}

/**
 * Determine whether the approval gate should be skipped for the current branch.
 *
 * Returns true ONLY when:
 *   1. The protection has an `environments` map
 *   2. The current branch can be detected
 *   3. The branch matches an environment's branchPattern
 *   4. That environment has `requireApproval: false`
 *
 * In all other cases (missing environments config, branch detection failure,
 * no matching pattern, or requireApproval not explicitly false) returns false
 * to fail-closed per G001.
 *
 * @param {object} protection - Protection config from protected-actions.json
 * @returns {boolean} true if approval should be skipped for this branch
 */
function shouldSkipApproval(protection) {
  // No environments config → backward compatible, require approval
  if (!protection.environments || typeof protection.environments !== 'object') {
    return false;
  }

  const branch = detectCurrentBranch();
  if (!branch) {
    // G001 Fail-Closed: cannot determine branch, assume approval required
    return false;
  }

  for (const envConfig of Object.values(protection.environments)) {
    if (!envConfig || typeof envConfig.branchPattern !== 'string') {
      continue;
    }
    if (branchMatchesPattern(branch, envConfig.branchPattern)) {
      // Only skip if requireApproval is explicitly false — any other value requires approval
      return envConfig.requireApproval === false;
    }
  }

  // No matching environment pattern → require approval (fail-closed)
  return false;
}

// ============================================================================
// Code Generation
// ============================================================================

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

// ============================================================================
// Deferred Action Support (unified path for all sessions)
// ============================================================================

const IS_SPAWNED = process.env.CLAUDE_SPAWNED_SESSION === 'true';

/**
 * Create a deferred action for a blocked MCP tool call.
 * Both interactive and spawned sessions use this path.
 * The action is stored in the DB and will be executed when the CTO approves it
 * via the unified authorization flow (record_cto_decision -> auditor -> auto-execute).
 * Returns the deferred action record, or null on failure.
 */
async function createDeferredActionRecord(server, tool, args, phrase) {
  try {
    const { openDb, createDeferredAction: createRecord, findDuplicatePending } = await import('./lib/deferred-action-db.js');
    const { computePendingHmac } = await import('./lib/deferred-action-executor.js');

    const db = openDb();
    if (!db) return null;

    try {
      const argsHash = crypto.createHash('sha256')
        .update(JSON.stringify(args || {}))
        .digest('hex');

      // Check for duplicate pending request with same server+tool+args
      const existing = findDuplicatePending(db, server, tool, argsHash);
      if (existing) {
        return { code: existing.code, id: existing.id, duplicate: true };
      }

      const code = generateCode();
      const pendingHmac = computePendingHmac(code, server, tool, argsHash);
      if (!pendingHmac) return null; // Protection key missing

      const record = createRecord(db, {
        server,
        tool,
        args,
        argsHash,
        code,
        phrase,
        pendingHmac,
        requesterAgentId: process.env.CLAUDE_AGENT_ID || null,
        requesterSessionId: process.env.CLAUDE_SESSION_ID || null,
        requesterTaskType: process.env.GENTYR_PERSISTENT_TASK_ID ? 'persistent' : null,
        requesterTaskId: process.env.GENTYR_PERSISTENT_TASK_ID || null,
        // Phase 1 adds sourceHook support — pass it when available
        sourceHook: 'protected-action-gate',
      });

      return record;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[protected-action-gate] Failed to create deferred action: ${err.message}`);
    return null;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
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
    logBlockedAction(mcpInfo.server, mcpInfo.tool, 'G001: config corrupted');
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
    blockAndExit();
  }

  // G001 Fail-Closed: If config file is missing, block ALL MCP actions
  // This prevents attack A4/C5: agent deletes/moves config to bypass protections
  if (config.notConfigured) {
    logBlockedAction(mcpInfo.server, mcpInfo.tool, 'G001: config not found');
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  G001 FAIL-CLOSED: Protected actions config not found');
    console.error('');
    console.error('  File: .claude/hooks/protected-actions.json');
    console.error('  ALL MCP actions are blocked until config is restored.');
    console.error('  Run: setup.sh --path <project> to reinstall GENTYR');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
    blockAndExit();
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
    logBlockedAction(mcpInfo.server, mcpInfo.tool, 'unrecognized MCP server');
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
    blockAndExit();
  }

  // Check if this branch is exempt from approval for this protection
  if (shouldSkipApproval(protection)) {
    // This branch has requireApproval: false — allow without CTO approval
    process.exit(0);
  }

  // Parse tool arguments
  let args = {};
  try {
    args = JSON.parse(toolInput);
  } catch (err) {
    // Can't parse args, but still need to check protection
  }

  // G001 Fail-Closed: If protection key is missing and we have protected actions,
  // we cannot sign HMAC for deferred actions. Block the action.
  const protectionKey = loadProtectionKey();
  if (!protectionKey) {
    logBlockedAction(mcpInfo.server, mcpInfo.tool, 'G001: protection key missing');
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  G001 FAIL-CLOSED: Protection key missing');
    console.error('');
    console.error('  File: .claude/protection-key');
    console.error('  Cannot sign deferred action without protection key.');
    console.error('  Run: setup.sh --path <project> to reinstall GENTYR');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
    blockAndExit();
  }

  // ── Unified path: create a deferred action for ALL sessions ──────────────
  // Both interactive and spawned sessions create deferred actions.
  // The deferred action auto-executes after CTO approval + audit pass.
  // The agent NEVER retries — the system fires the tool call autonomously.
  const deferred = await createDeferredActionRecord(mcpInfo.server, mcpInfo.tool, args, protection.phrase);

  if (!deferred) {
    // Deferred creation failed — hard block
    logBlockedAction(mcpInfo.server, mcpInfo.tool, 'G001: failed to create deferred action');
    console.error(JSON.stringify({
      error: '[protected-action-gate] G001 FAIL-CLOSED: Could not create deferred action. Action blocked.'
    }));
    blockAndExit();
    return;
  }

  // Determine if this is a Tier 1 or Tier 2 server for the denial message
  let isTier1 = false;
  try {
    const { isTier1Server } = await import('./lib/deferred-action-executor.js');
    isTier1 = isTier1Server(mcpInfo.server);
  } catch { /* non-fatal — assume Tier 2 */ }

  const tier2Note = !isTier1
    ? `\n  NOTE: ${mcpInfo.server} is a Tier 2 server. After approval, the action must be retried manually (auto-execution only works for Tier 1 servers).`
    : '';

  // Log the block for stderr (human-visible in terminal)
  if (deferred.duplicate) {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  PROTECTED ACTION BLOCKED (duplicate deferred action exists)');
    console.error('');
    console.error(`  Server: ${mcpInfo.server}`);
    console.error(`  Tool:   ${mcpInfo.tool}`);
    console.error(`  Deferred Action ID: ${deferred.id}`);
    console.error('');
    console.error('  A deferred action already exists for this exact server+tool+args.');
    console.error('  The CTO will be notified at their next interactive session.');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
  } else {
    console.error('');
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('  PROTECTED ACTION BLOCKED: Deferred for CTO Authorization');
    console.error('');
    console.error(`  Server: ${mcpInfo.server}`);
    console.error(`  Tool:   ${mcpInfo.tool}`);
    console.error(`  Deferred Action ID: ${deferred.id}`);
    console.error('');
    if (Object.keys(args).length > 0) {
      console.error('  Arguments:');
      const argsStr = JSON.stringify(args, null, 2).split('\n');
      argsStr.forEach(line => console.error(`    ${line}`));
      console.error('');
    }
    console.error('  The tool call has been captured as a deferred action.');
    console.error('  It will auto-execute after CTO approval + audit pass.');
    if (tier2Note) {
      console.error(tier2Note);
    }
    console.error('══════════════════════════════════════════════════════════════════════');
    console.error('');
  }

  logBlockedAction(mcpInfo.server, mcpInfo.tool, 'deferred for CTO authorization');

  // Build the denial reason — this is the ONLY text the agent sees.
  // Different instructions depending on interactive vs spawned.
  if (IS_SPAWNED) {
    // ── Spawned agent path: file bypass request and exit ─────────────────
    const taskId = process.env.GENTYR_PERSISTENT_TASK_ID || process.env.GENTYR_TASK_ID || null;
    const taskType = process.env.GENTYR_PERSISTENT_TASK_ID ? 'persistent' : (process.env.GENTYR_TASK_ID ? 'todo' : null);

    const reason = [
      `PROTECTED ACTION BLOCKED: ${mcpInfo.server}:${mcpInfo.tool} requires CTO approval.`,
      `A deferred action has been created (ID: ${deferred.id}).`,
      `The tool call will execute automatically after CTO approval + audit — you do NOT need to retry it.`,
      '',
      `YOU MUST NOW: Call submit_bypass_request with these exact arguments:`,
      `  task_type: "${taskType || 'todo'}"`,
      `  task_id: "${taskId || '<your task ID>'}"`,
      `  category: "protected_action"`,
      `  summary: "Blocked on ${mcpInfo.server}:${mcpInfo.tool} — deferred action ${deferred.id} awaiting CTO approval"`,
      `  details: "The deferred action will auto-execute when approved. Resume this task after approval."`,
      `Then call summarize_work and exit. Do NOT continue working — this action requires CTO approval.`,
    ].join('\n');

    process.stdout.write(JSON.stringify({
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    }));
    process.exit(0);
  } else {
    // ── Interactive session path: present to CTO via record_cto_decision ──
    const reason = [
      `PROTECTED ACTION BLOCKED: ${mcpInfo.server}:${mcpInfo.tool} requires CTO approval.`,
      `A deferred action has been created (ID: ${deferred.id}).`,
      `The tool call will execute automatically after CTO approval + audit — you do NOT need to retry it.`,
      tier2Note ? tier2Note.trim() : '',
      '',
      `NEXT STEPS:`,
      `1. Present this blocked action to the CTO — explain what ${mcpInfo.server}:${mcpInfo.tool} does and why it is needed.`,
      `2. After the CTO provides their decision in natural language, call:`,
      `   mcp__agent-tracker__record_cto_decision({`,
      `     decision_type: "protected_action_gate",`,
      `     decision_id: "${deferred.id}",`,
      `     verbatim_text: "<CTO's exact words>"`,
      `   })`,
      `3. The system will verify the CTO's text in the session JSONL, spawn an independent auditor,`,
      `   and auto-execute the tool call after audit pass.`,
      ``,
      `Do NOT retry this tool call. The deferred action system handles execution automatically.`,
    ].filter(Boolean).join('\n');

    process.stdout.write(JSON.stringify({
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    }));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`[protected-action-gate] Fatal error: ${err.message}`);
  process.exit(1);
});
