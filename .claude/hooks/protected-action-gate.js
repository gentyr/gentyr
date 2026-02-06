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
 * @version 1.0.1
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

// PreToolUse hooks receive tool info via environment variables
const toolName = process.env.TOOL_NAME || '';
const toolInput = process.env.TOOL_INPUT || '{}';

// ============================================================================
// MCP Tool Detection
// ============================================================================

/**
 * Parse MCP tool name into server and tool components
 * Format: mcp__servername__toolname
 * @param {string} name - Full tool name
 * @returns {object|null} { server, tool } or null if not an MCP tool
 */
function parseMcpToolName(name) {
  const match = name.match(/^mcp__([^_]+)__(.+)$/);
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
      // Config doesn't exist yet - this is the "not yet configured" state
      // Safe to allow all actions through (no protections defined)
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
 * Check if there's a valid approval for this action
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @returns {object|null} Approval if valid, null otherwise
 */
function checkApproval(server, tool) {
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
 * Create a pending approval request
 * @param {string} server - MCP server name
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments
 * @param {string} phrase - Approval phrase
 * @returns {object} Request details
 */
function createRequest(server, tool, args, phrase) {
  const code = generateCode();
  const now = Date.now();
  const expiryMs = 5 * 60 * 1000; // 5 minutes

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
    expires_at: new Date(now + expiryMs).toISOString(),
    expires_timestamp: now + expiryMs,
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

  // If not configured yet (file doesn't exist), allow all
  if (config.notConfigured) {
    process.exit(0);
  }

  // Check if this action is protected
  const protection = getProtection(mcpInfo.server, mcpInfo.tool, config);
  if (!protection) {
    // Not protected, allow
    process.exit(0);
  }

  // Parse tool arguments
  let args = {};
  try {
    args = JSON.parse(toolInput);
  } catch (err) {
    // Can't parse args, but still need to check protection
  }

  // Check for valid approval
  const approval = checkApproval(mcpInfo.server, mcpInfo.tool);
  if (approval) {
    // Has valid approval, allow
    console.error(`[protected-action-gate] Approval verified for ${mcpInfo.server}:${mcpInfo.tool}`);
    process.exit(0);
  }

  // No approval - block and request one
  const request = createRequest(mcpInfo.server, mcpInfo.tool, args, protection.phrase);

  // Output block message
  console.error('');
  console.error('══════════════════════════════════════════════════════════════════════');
  console.error('  PROTECTED ACTION BLOCKED: CTO Approval Required');
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
  console.error(`  To approve, CTO must type exactly:`);
  console.error('');
  console.error(`      ${request.message}`);
  console.error('');
  console.error('  This code expires in 5 minutes.');
  console.error('  After CTO types approval, retry this action.');
  console.error('══════════════════════════════════════════════════════════════════════');
  console.error('');

  // Exit with error to block the tool call
  process.exit(1);
}

main();
