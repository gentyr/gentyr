#!/usr/bin/env node
/**
 * PreToolUse Hook: Interactive Session Lockdown Guard
 *
 * Enforces the deputy-CTO console model: in interactive (non-spawned) sessions,
 * only read/observe tools are allowed. File-editing tools (Edit, Write, etc.)
 * and sub-agent spawning tools (Agent, Task) are blocked.
 *
 * This transforms the interactive Claude Code session into a read-only
 * "deputy-CTO console" where Claude manages the engineering team through
 * GENTYR's task and agent system rather than editing files directly.
 *
 * Bypass: set `interactiveLockdownDisabled: true` in automation-config.json.
 * This is intended for development/debugging only — a warning is injected
 * into the AI model's context when lockdown is disabled.
 *
 * Spawned sessions (`CLAUDE_SPAWNED_SESSION=true`) are always unrestricted —
 * they need full tool access to do their work.
 *
 * Location: .claude/hooks/interactive-lockdown-guard.js
 * Auto-propagates to target projects via directory symlink (npm link model)
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision (deny/allow)
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Tools allowed in interactive (deputy-CTO console) sessions.
 *
 * These are read/observe/query tools that the deputy-CTO needs to:
 * - Read code and documentation (Read, Glob, Grep)
 * - Run read-only shell commands — git log, gh pr list, etc. (Bash)
 * - Fetch external URLs for reference (WebFetch, WebSearch)
 * - Ask the CTO clarifying questions (AskUserQuestion)
 * - Invoke slash commands and search tool schemas (Skill, ToolSearch)
 *
 * Everything NOT in this set is blocked for interactive sessions.
 * MCP tools (mcp__*) are whitelisted by server prefix below.
 */
const ALLOWED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'Skill',
  'ToolSearch',
  'Agent',   // Allowed but filtered — only read-only sub-agent types pass (see below)
  'Task',    // Same filtering as Agent
]);

/**
 * Read-only sub-agent types allowed in interactive mode.
 * These agents only read code — they never edit files or run git write ops.
 */
const READONLY_SUBAGENT_TYPES = new Set([
  'Explore',
  'Plan',
  'investigator',
  'general-purpose',
  'product-manager',
  'claude-code-guide',
  'statusline-setup',
  'deputy-cto',
  'antipattern-hunter',
  'repo-hygiene-expert',
  'secret-manager',
  'icon-finder',
]);

/**
 * MCP tool prefixes allowed in interactive mode.
 * Only monitoring, reading, and task-management tools — no write/mutate operations
 * on infrastructure (secret-sync, cloudflare, supabase, render, vercel, etc.).
 */
const ALLOWED_MCP_PREFIXES = [
  'mcp__deputy-cto__',         // Triage, questions, approvals
  'mcp__todo-db__',            // Task management (create, list, complete)
  'mcp__agent-tracker__',      // Agent monitoring, signals, session queue
  'mcp__agent-reports__',      // Read agent reports
  'mcp__cto-report__',         // CTO dashboard data
  'mcp__show__',               // Show dashboard sections
  'mcp__persistent-task__',    // Persistent task management
  'mcp__plan-orchestrator__',  // Plan management
  'mcp__user-feedback__',      // Feedback/persona data (read)
  'mcp__product-manager__',    // PMF analysis (approve, status)
  'mcp__playwright__',         // Demo/test launching
  'mcp__specs-browser__',      // Read specs
  'mcp__feedback-explorer__',  // Browse feedback
  'mcp__setup-helper__',       // Setup guidance
  'mcp__workstream__',         // Workstream management
  'mcp__chrome-bridge__',      // Chrome automation
];

/**
 * Specific MCP tools blocked even within allowed prefixes.
 * These require CTO bypass approval — they change system-level settings.
 */
const BLOCKED_MCP_TOOLS = new Set([
  'mcp__agent-tracker__set_max_concurrent_sessions',  // Changing concurrency limits
]);

/**
 * Bash commands blocked in interactive mode.
 * These are write/mutate operations the deputy-CTO should delegate to agents.
 */
const BLOCKED_BASH_PATTERNS = [
  // Git write operations
  /\bgit\s+(checkout|switch|clean|reset|stash|add|commit|push|merge|rebase|cherry-pick|pull)\b/,
  // Build/install commands
  /\b(pnpm|npm|yarn|npx)\s+(run\s+build|build|install|link|publish)\b/,
  /\bswift\s+build\b/,
  /\btsc\b/,
  // File mutation
  /\brm\s+-[rf]/,
  /\bmkdir\b/,
  /\bcp\s/,
  /\bmv\s/,
  /\bchmod\b/,
  /\bchown\b/,
  // Process management
  /\bkill\b/,
  // Dangerous operations
  /\bsudo\b/,
  /\beval\s/,
];

/**
 * Check if a valid CTO bypass token exists (consumed on use).
 * Mirrors the check in block-no-verify.js but without HMAC (workflow guard, not security).
 * @returns {boolean}
 */
function consumeBypassToken() {
  try {
    const tokenPath = path.join(PROJECT_DIR, '.claude', 'bypass-approval-token.json');
    if (!fs.existsSync(tokenPath)) return false;
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (!token.code || !token.expires_timestamp) return false;
    if (Date.now() > token.expires_timestamp) {
      fs.writeFileSync(tokenPath, '{}');
      return false;
    }
    // Valid — consume (one-time use)
    fs.writeFileSync(tokenPath, '{}');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read automation-config.json to check if lockdown is disabled.
 * Returns false (lockdown enabled) if the file cannot be read.
 * @returns {boolean}
 */
function isLockdownDisabled() {
  try {
    const configPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    return config.interactiveLockdownDisabled === true;
  } catch {
    // File missing or unparseable — lockdown is ENABLED by default (fail-closed)
    return false;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch (err) {
    // G001: fail-closed on parse errors
    process.stderr.write(`[interactive-lockdown-guard] G001 FAIL-CLOSED: Failed to parse input: ${err.message}\n`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `G001 FAIL-CLOSED: Hook error — ${err.message}`,
      },
    }));
    return;
  }

  const toolName = event?.tool_name || '';

  // Happy path: spawned sessions bypass the lockdown immediately (< 1ms)
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Interactive monitor sessions bypass lockdown — they need full tool access for sub-agent orchestration
  if (process.env.GENTYR_INTERACTIVE_MONITOR === 'true') {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Check lockdown disabled flag (interactive sessions only)
  if (isLockdownDisabled()) {
    const warning = '[LOCKDOWN DISABLED] The deputy-CTO lockdown is currently disabled. You have full tool access. Remember to re-enable via /lockdown on for proper GENTYR workflow.';
    process.stdout.write(JSON.stringify({
      decision: 'approve',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: warning,
      },
    }));
    return;
  }

  // MCP tools: whitelist by server prefix, with individual blocklist
  if (toolName.startsWith('mcp__')) {
    // Check individual blocklist (requires CTO bypass token)
    if (BLOCKED_MCP_TOOLS.has(toolName)) {
      if (consumeBypassToken()) {
        // CTO approved — allow this one call
        process.stdout.write(JSON.stringify({ decision: 'approve' }));
        return;
      }
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Deputy-CTO console: \`${toolName}\` requires CTO bypass approval.\n\nThis tool changes system-level settings. Request a bypass via mcp__deputy-cto__request_bypass.`,
        },
      }));
      return;
    }
    const allowed = ALLOWED_MCP_PREFIXES.some(prefix => toolName.startsWith(prefix));
    if (allowed) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      return;
    }
    // Block non-whitelisted MCP tools
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Deputy-CTO console: \`${toolName}\` is not available in interactive mode.\n\nThis MCP tool is for infrastructure management. Create a task to delegate this work to an agent.`,
      },
    }));
    return;
  }

  // Agent/Task: only allow read-only sub-agent types
  if (toolName === 'Agent' || toolName === 'Task') {
    const subagentType = event?.tool_input?.subagent_type || event?.tool_input?.subagentType || '';
    if (READONLY_SUBAGENT_TYPES.has(subagentType)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      return;
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Deputy-CTO console: \`${toolName}(subagent_type='${subagentType}')\` is not available in interactive mode.\n\nOnly read-only sub-agents are allowed: ${[...READONLY_SUBAGENT_TYPES].join(', ')}.\n\nTo spawn code-modifying agents, create a task via mcp__todo-db__create_task.\nOr use /spawn-tasks for interactive task creation and spawning.`,
      },
    }));
    return;
  }

  // Bash: check for blocked command patterns
  if (toolName === 'Bash') {
    const command = event?.tool_input?.command || '';
    for (const pattern of BLOCKED_BASH_PATTERNS) {
      if (pattern.test(command)) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Deputy-CTO console: This Bash command is not available in interactive mode.\n\nBlocked: \`${command.substring(0, 80)}\`\n\nWrite operations (git checkout, builds, file mutations) must be delegated to agents via tasks. Use read-only commands (git log, git status, git diff, gh pr list, ls, cat, grep) for investigation.`,
          },
        }));
        return;
      }
    }
  }

  // Allowed tools pass through
  if (ALLOWED_TOOLS.has(toolName)) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Block everything else
  const reason = [
    `Deputy-CTO console: \`${toolName}\` is not available in interactive mode.`,
    '',
    'In interactive sessions, you are the Deputy-CTO. You manage the engineering',
    'team through GENTYR\'s task and agent system — you do not edit files directly.',
    '',
    'To make code changes, create a task and spawn an agent:',
    '  1. mcp__todo-db__create_task({ section: \'CODE-REVIEWER\', title: \'...\', description: \'...\', assigned_by: \'cto\' })',
    '  2. mcp__agent-tracker__force_spawn_tasks({ taskIds: [\'...\'] })',
    '  3. mcp__agent-tracker__monitor_agents({ agentIds: [\'...\'] })',
    '',
    'Or use /spawn-tasks for interactive task creation and spawning.',
    '',
    'To disable this lockdown temporarily (development only):',
    '  /lockdown off',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

main().catch((err) => {
  // G001: fail-closed on unexpected errors
  process.stderr.write(`[interactive-lockdown-guard] G001 FAIL-CLOSED: Unexpected error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `G001 FAIL-CLOSED: Hook error — ${err.message}`,
    },
  }));
});
