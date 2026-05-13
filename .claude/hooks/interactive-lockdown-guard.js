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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDeferredAction, openDb, findDuplicatePending } from './lib/deferred-action-db.js';
import { computePendingHmac } from './lib/deferred-action-executor.js';

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
  'StructuredOutput', // Required for the AI model's structured output — blocking this breaks the session
  'Agent',   // Allowed but filtered — only read-only sub-agent types pass (see below)
  'Task',    // Same filtering as Agent
  'EnterPlanMode',   // CTO plan mode — allowed in lockdown (read-only planning)
  'ExitPlanMode',    // CTO plan mode — allowed in lockdown (exits plan mode, writes plan file)
]);

/**
 * Read-only sub-agent types allowed in interactive mode.
 * These agents only read code — they never edit files or run git write ops.
 */
const READONLY_SUBAGENT_TYPES = new Set([
  'Explore',
  'Plan',
  'claude-code-guide',
  'deputy-cto',
  'feedback-agent',
  'investigator',
  'product-manager',
  'repo-hygiene-expert',
  'secret-manager',
  'statusline-setup',
  'user-alignment',
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
  'mcp__release-ledger__',     // Production release management (sign-off, listing)
  'mcp__claude-sessions__',    // Session search/read (read-only introspection)
];

/**
 * Individual MCP tools allowed from otherwise-blocked server prefixes.
 * These are safe read/config operations on servers that also have write tools.
 */
const ALLOWED_MCP_INDIVIDUAL = new Set([
  'mcp__secret-sync__get_services_config',       // Read config (no secrets)
  'mcp__secret-sync__update_services_config',     // Update config (secrets key blocked by handler)
  'mcp__onepassword__check_auth',                 // Auth status — no secret access
  'mcp__onepassword__list_items',                 // Item names only — no secret values
  'mcp__onepassword__op_vault_map',               // Returns op:// references — no secret values
  'mcp__onepassword__read_secret',                // Metadata check — include_value:false (default) only confirms existence
  'mcp__onepassword__create_item',                // Create items — values go direct to op CLI
  'mcp__onepassword__add_item_fields',            // Add fields — values go direct to op CLI
  'mcp__secret-sync__populate_secrets_local',     // Writes op:// refs only — no secret values in context
]);

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
 * Create a deferred action for a blocked tool call.
 * @param {string} toolName - The blocked tool name
 * @param {object} toolInput - The tool arguments
 * @returns {{ id: string, code: string } | null} Deferred action info or null on failure
 */
function createLockdownDeferredAction(toolName, toolInput) {
  try {
    const db = openDb();
    if (!db) return null;

    try {
      const argsJson = JSON.stringify(toolInput || {});
      const argsHash = crypto.createHash('sha256').update(argsJson).digest('hex');
      const server = toolName.startsWith('mcp__') ? toolName.split('__')[1] || 'claude' : 'claude';
      const tool = toolName;

      const existing = findDuplicatePending(db, server, tool, argsHash);
      if (existing) {
        return { id: existing.id, code: existing.code };
      }

      const code = crypto.randomBytes(3).toString('hex').toUpperCase();
      const pendingHmac = computePendingHmac(code, server, tool, argsHash);
      if (!pendingHmac) return null; // G001 fail-closed

      const result = createDeferredAction(db, {
        server,
        tool,
        args: toolInput || {},
        argsHash,
        code,
        phrase: 'UNIFIED',
        pendingHmac,
        sourceHook: 'interactive-lockdown-guard',
      });

      return { id: result.id, code: result.code };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return null;
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
    // Read CTO worktree path from config
    let ctoWorktreePath = '';
    try {
      const configPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      ctoWorktreePath = config.ctoWorktreePath || '';
    } catch { /* non-fatal */ }

    // Block Write/Edit/NotebookEdit to main tree — all code edits must go through the worktree
    if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
      const filePath = path.resolve(event?.tool_input?.file_path || '');
      const worktreesDir = path.join(PROJECT_DIR, '.claude', 'worktrees');
      const claudeDir = path.join(PROJECT_DIR, '.claude');
      const homeClaudeDir = path.join(os.homedir(), '.claude');

      const isInWorktree = filePath.startsWith(worktreesDir + path.sep);
      const isFrameworkFile = filePath.startsWith(claudeDir + path.sep);
      const isMemoryFile = filePath.startsWith(homeClaudeDir + path.sep);

      if (filePath && !isInWorktree && !isFrameworkFile && !isMemoryFile) {
        const wtHint = ctoWorktreePath || 'Run /lockdown off to provision a worktree';
        const reason = [
          'BLOCKED: Main-tree edits are not allowed even with lockdown off.',
          '',
          `Use your CTO worktree: cd ${wtHint}`,
          'Then edit the equivalent file path inside the worktree.',
          '',
          'This prevents conflicts with other running agents.',
          'When done: commit, push, create PR to preview, then /lockdown on.',
        ].join('\n');
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }));
        return;
      }
    }

    // Approve all other tools with workflow guidance
    const guidance = [
      '[LOCKDOWN OFF] Worktree workflow active.',
      ctoWorktreePath ? `Worktree: ${ctoWorktreePath}` : 'No worktree provisioned — run /lockdown off to create one.',
      'All code edits must happen in the worktree.',
      'When done: commit, push, create PR to preview, then /lockdown on.',
    ].join(' | ');
    process.stdout.write(JSON.stringify({
      decision: 'approve',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: guidance,
      },
    }));
    return;
  }

  // MCP tools: whitelist by server prefix, with individual blocklist
  if (toolName.startsWith('mcp__')) {
    // Check individual blocklist — create deferred action and deny unconditionally
    if (BLOCKED_MCP_TOOLS.has(toolName)) {
      const deferred = createLockdownDeferredAction(toolName, event?.tool_input);
      const deferredMsg = deferred
        ? `\n\nDeferred action created: ${deferred.id}\nPresent this to the CTO, then call record_cto_decision({ decision_type: "lockdown_toggle", decision_id: "${deferred.id}", verbatim_text: "<CTO exact words>" }). The action will auto-execute after approval + audit.`
        : '';
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Deputy-CTO console: \`${toolName}\` requires CTO authorization.\n\nThis tool changes system-level settings.${deferredMsg}`,
        },
      }));
      return;
    }
    // Check individual allowlist (specific tools from otherwise-blocked servers)
    if (ALLOWED_MCP_INDIVIDUAL.has(toolName)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      return;
    }
    const allowed = ALLOWED_MCP_PREFIXES.some(prefix => toolName.startsWith(prefix));
    if (allowed) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      return;
    }
    // Block non-whitelisted MCP tools — create deferred action
    {
      const deferred = createLockdownDeferredAction(toolName, event?.tool_input);
      const deferredMsg = deferred
        ? `\n\nDeferred action created: ${deferred.id}\nPresent this to the CTO, then call record_cto_decision({ decision_type: "lockdown_toggle", decision_id: "${deferred.id}", verbatim_text: "<CTO exact words>" }). The action will auto-execute after approval + audit.`
        : '';
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Deputy-CTO console: \`${toolName}\` is not available in interactive mode.\n\nThis MCP tool is for infrastructure management. Create a task to delegate this work to an agent.${deferredMsg}`,
        },
      }));
    }
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

  // Bash: check for blocked command patterns — create deferred action and deny
  if (toolName === 'Bash') {
    const command = event?.tool_input?.command || '';
    for (const pattern of BLOCKED_BASH_PATTERNS) {
      if (pattern.test(command)) {
        const deferred = createLockdownDeferredAction(toolName, event?.tool_input);
        const deferredMsg = deferred
          ? `\n\nDeferred action created: ${deferred.id}\nPresent this to the CTO, then call record_cto_decision({ decision_type: "lockdown_toggle", decision_id: "${deferred.id}", verbatim_text: "<CTO exact words>" }).`
          : '';
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Deputy-CTO console: This Bash command is not available in interactive mode.\n\nBlocked: \`${command.substring(0, 80)}\`\n\nWrite operations (git checkout, builds, file mutations) must be delegated to agents via tasks. Use read-only commands (git log, git status, git diff, gh pr list, ls, cat, grep) for investigation.${deferredMsg}`,
          },
        }));
        return;
      }
    }
  }

  // Plan file whitelist: CTO can write/edit plan files even in lockdown
  // Plans are metadata/documentation, not code — treating them like read operations
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = event?.tool_input?.file_path || '';
    if (filePath) {
      const resolved = path.resolve(filePath);
      const plansDir = path.join(PROJECT_DIR, '.claude', 'plans');
      if (resolved === plansDir || resolved.startsWith(plansDir + path.sep)) {
        process.stdout.write(JSON.stringify({ decision: 'approve' }));
        return;
      }
    }
  }

  // Memory file whitelist: CTO can write/edit memory files even in lockdown.
  // Memory files are auto-memory persistence, not code.
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = event?.tool_input?.file_path || '';
    if (filePath) {
      const resolved = path.resolve(filePath);
      const memoryBase = path.join(os.homedir(), '.claude', 'projects');
      if (resolved.startsWith(memoryBase + path.sep) && resolved.includes(path.sep + 'memory' + path.sep)) {
        process.stdout.write(JSON.stringify({ decision: 'approve' }));
        return;
      }
    }
  }

  // Allowed tools pass through
  if (ALLOWED_TOOLS.has(toolName)) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Block everything else — create deferred action for the blocked tool call
  const deferred = createLockdownDeferredAction(toolName, event?.tool_input);
  const deferredMsg = deferred
    ? [
        '',
        `Deferred action created: ${deferred.id}`,
        `Present this to the CTO, then call record_cto_decision({ decision_type: "lockdown_toggle", decision_id: "${deferred.id}", verbatim_text: "<CTO exact words>" }).`,
        'The action will auto-execute after CTO approval + independent audit pass.',
      ].join('\n')
    : '';

  const reason = [
    `Deputy-CTO console: \`${toolName}\` is not available in interactive mode.`,
    '',
    'In interactive sessions, you are the Deputy-CTO. You manage the engineering',
    'team through GENTYR\'s task and agent system — you do not edit files directly.',
    '',
    'To make code changes, create a task and spawn an agent:',
    '  1. mcp__todo-db__create_task({ category_id: \'standard\', title: \'...\', description: \'...\', assigned_by: \'cto\' })',
    '  2. mcp__agent-tracker__force_spawn_tasks({ taskIds: [\'...\'] })',
    '  3. mcp__agent-tracker__monitor_agents({ agentIds: [\'...\'] })',
    '',
    'Or use /spawn-tasks for interactive task creation and spawning.',
    '',
    'To disable this lockdown temporarily (development only):',
    '  /lockdown off',
    deferredMsg,
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
