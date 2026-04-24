#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: MCP Server Guidance
 *
 * Two triggers (either fires the hook):
 * 1. User prompt contains "mcp" (case-insensitive) — injects guidance about
 *    project-local MCP server support and the stage_mcp_server tool.
 * 2. mcp-servers-pending.json exists — notifies the CTO that staged servers
 *    are waiting for `npx gentyr sync`.
 *
 * Output: silent additionalContext only (no systemMessage / terminal noise).
 * Cooldown: 30 minutes for keyword trigger. Pending check has no cooldown.
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Output helpers
// ============================================================================

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function injectContext(context) {
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }));
  process.exit(0);
}

// ============================================================================
// Fast-path: skip spawned sessions
// ============================================================================

if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  silent();
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const STATE_PATH = path.join(STATE_DIR, 'mcp-guidance-state.json');
const PENDING_PATH = path.join(STATE_DIR, 'mcp-servers-pending.json');
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ============================================================================
// State management
// ============================================================================

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { lastKeywordCheck: 0 };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch { /* non-fatal */ }
}

// ============================================================================
// Stdin consumption (required by hook harness)
// ============================================================================

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });

process.stdin.on('end', () => {
  try {
    const now = Date.now();
    const state = readState();

    // Extract user prompt
    let prompt = '';
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed.user_prompt === 'string') prompt = parsed.user_prompt;
      else if (typeof parsed.prompt === 'string') prompt = parsed.prompt;
    } catch {
      prompt = typeof input === 'string' ? input : '';
    }
    prompt = prompt.trim();

    // Skip slash commands
    if (!prompt || prompt.startsWith('/') || prompt.includes('<!-- HOOK:GENTYR:')) {
      silent();
    }

    // --- Trigger 1: keyword "mcp" in prompt (with cooldown) ---
    const hasMcpKeyword = /\bmcp\b/i.test(prompt);
    const keywordCooldownActive = state.lastKeywordCheck && (now - state.lastKeywordCheck) < COOLDOWN_MS;

    // --- Trigger 2: pending staged servers (no cooldown) ---
    let pendingServers = null;
    let pendingCount = 0;
    try {
      if (fs.existsSync(PENDING_PATH)) {
        const pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'));
        const servers = pending.servers || {};
        pendingCount = Object.keys(servers).length;
        if (pendingCount > 0) {
          pendingServers = Object.keys(servers);
        }
      }
    } catch { /* non-fatal */ }

    // Nothing to inject
    if (!pendingServers && (!hasMcpKeyword || keywordCooldownActive)) {
      silent();
    }

    // Build context
    const parts = [];

    if (hasMcpKeyword && !keywordCooldownActive) {
      parts.push(
        '[MCP Server Guidance] GENTYR preserves project-local MCP servers across `npx gentyr sync`.',
        'To add a new MCP server to this project, use: mcp__agent-tracker__stage_mcp_server({ name: "server-name", config: { command: "npx", args: ["-y", "@scope/mcp-server"], env: { API_KEY: "..." } } })',
        'If .mcp.json is protected (root-owned), the server is staged and applied on the next `npx gentyr sync`.',
        'After installation, the CTO must restart the Claude Code session for new MCP tools to appear.',
      );
      state.lastKeywordCheck = now;
      writeState(state);
    }

    if (pendingServers) {
      parts.push(
        `[Pending MCP Servers] ${pendingCount} staged MCP server(s) awaiting activation: ${pendingServers.join(', ')}.`,
        'Run `npx gentyr sync` to apply, then restart the Claude Code session.',
      );
    }

    injectContext(parts.join('\n'));
  } catch {
    // Non-fatal — never block user input
    silent();
  }
});
