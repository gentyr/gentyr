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
 *
 * NOTE: `mcp__playwright__` and `mcp__chrome-bridge__` are deliberately NOT in this
 * list — they were previously prefix-allowed but the deputy-CTO used that surface
 * to "take over" demo execution (running run_demo_batch, run_auth_setup directly)
 * instead of delegating via tasks. Read-only inspection tools from those servers
 * are whitelisted individually below; write/work tools fall through to the
 * `MCP_DELEGATION_GUIDANCE` deny path.
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
  'mcp__specs-browser__',      // Read specs
  'mcp__feedback-explorer__',  // Browse feedback
  'mcp__setup-helper__',       // Setup guidance
  'mcp__workstream__',         // Workstream management
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
  // Playwright — read-only inspection tools (the CTO needs these to monitor demo state)
  'mcp__playwright__check_demo_result',
  'mcp__playwright__check_demo_batch_result',
  'mcp__playwright__get_fly_status',
  'mcp__playwright__get_fly_logs',
  'mcp__playwright__get_fly_machine_ram',
  'mcp__playwright__get_demo_screenshot',
  'mcp__playwright__get_report',
  'mcp__playwright__get_coverage_status',
  'mcp__playwright__get_display_queue_status',
  'mcp__playwright__preflight_check',
  'mcp__playwright__tail_running_fly_demo',
  'mcp__playwright__infrastructure_readiness',
  'mcp__playwright__worktree_freshness',
  'mcp__playwright__test_files_exist',
  'mcp__playwright__steel_health_check',
  'mcp__playwright__list_extension_tabs',
  'mcp__playwright__open_video',
  'mcp__playwright__extract_video_frames',
  'mcp__playwright__stop_demo',          // intervention, not work
  'mcp__playwright__stop_demo_batch',    // intervention, not work
  'mcp__playwright__release_display_lock', // CTO can release stuck locks
  // Chrome-bridge — read-only inspection tools
  'mcp__chrome-bridge__health_check',
  'mcp__chrome-bridge__page_diagnostic',
  'mcp__chrome-bridge__inspect_input',
  'mcp__chrome-bridge__find_elements',
  'mcp__chrome-bridge__wait_for_element',
  'mcp__chrome-bridge__get_page_text',
  'mcp__chrome-bridge__read_console_messages',
  'mcp__chrome-bridge__read_network_requests',
  'mcp__chrome-bridge__read_page',
  'mcp__chrome-bridge__list_chrome_extensions',
  'mcp__chrome-bridge__shortcuts_list',
  'mcp__chrome-bridge__tabs_context_mcp',
]);

/**
 * Per-tool delegation guidance for tools that are NOT in ALLOWED_MCP_INDIVIDUAL
 * and NOT covered by an ALLOWED_MCP_PREFIXES entry. When the catch-all deny path
 * fires, it looks up the tool name here and includes the specific delegation hint
 * in the deny message — telling the deputy exactly how to delegate the work
 * instead of taking it over.
 *
 * Keep entries focused on the high-value "I'll take over" failure modes. The
 * generic deny message is reasonable as a fallback for everything else.
 */
const MCP_DELEGATION_GUIDANCE = {
  // Playwright write/work tools — the failure mode this PR addresses
  'mcp__playwright__run_demo':
    'Create a `Demo Execution` category task with the scenario_id(s) in the description and force-spawn it. The spawned demo-manager runs the demo in its own worktree.',
  'mcp__playwright__run_demo_batch':
    'Create a `Demo Execution` category task with the scenario_id list and force-spawn it. The spawned demo-manager will call run_demo_batch from inside its worktree.',
  'mcp__playwright__run_auth_setup':
    'Create a `Demo Execution` category task — auth setup runs as part of the spawned demo-manager pipeline. The deputy-CTO does not run auth directly.',
  'mcp__playwright__run_tests':
    'Create a `Test Suite Work` category task and force-spawn it. The spawned test-writer runs the test suite in its own worktree.',
  'mcp__playwright__run_prerequisites':
    'Create a `Demo Execution` category task — prerequisites run automatically before the demo. The deputy-CTO does not run prerequisites directly.',
  'mcp__playwright__deploy_fly_image':
    'Create a `Standard Development` category task titled "Deploy Fly base image" — a spawned agent handles the deploy.',
  'mcp__playwright__deploy_project_image':
    'Create a `Standard Development` category task titled "Deploy Fly project image" — a spawned agent handles the deploy. Project image redeploys happen automatically on lockfile/SHA drift; manual redeploy is rarely needed.',
  'mcp__playwright__set_fly_machine_ram':
    'Create a `Standard Development` task to adjust Fly machine RAM. Configuration changes belong in `services.json` via update_services_config, not ad-hoc tool calls.',
  'mcp__playwright__launch_ui_mode':
    'Run Playwright UI mode via `/demo` slash command or by creating a task — do not launch it directly from the deputy console.',
  'mcp__playwright__acquire_display_lock':
    'Display locks should be acquired by agents that need them, not by the deputy. If you need to free a stuck lock, use release_display_lock; if you need to force-take it, use mcp__agent-tracker__force_release_shared_resource.',
  'mcp__playwright__seed_data':
    'Create a `Standard Development` task — data seeding is work, not management.',
  'mcp__playwright__cleanup_data':
    'Create a `Standard Development` task — data cleanup is work, not management.',
  'mcp__playwright__upload_steel_extension':
    'Create a `Standard Development` task — extension uploads are work, not management.',
  // Chrome-bridge interaction tools
  'mcp__chrome-bridge__navigate':
    'Browser navigation is agent work. Create a task — the spawned agent controls Chrome from its worktree.',
  'mcp__chrome-bridge__click_by_text':
    'Browser clicks are agent work. Create a task — the spawned agent controls Chrome from its worktree.',
  'mcp__chrome-bridge__click_and_wait':
    'Browser clicks are agent work. Create a task — the spawned agent controls Chrome from its worktree.',
  'mcp__chrome-bridge__fill_input':
    'Form fills are agent work. Create a task — the spawned agent controls Chrome from its worktree.',
  'mcp__chrome-bridge__react_fill_input':
    'Form fills are agent work. Create a task — the spawned agent controls Chrome from its worktree.',
  'mcp__chrome-bridge__form_input':
    'Form input is agent work. Create a task — the spawned agent controls Chrome from its worktree.',
  'mcp__chrome-bridge__computer':
    'Direct keyboard/mouse control is agent work. Create a task — the spawned agent controls Chrome from its worktree.',
  'mcp__chrome-bridge__javascript_tool':
    'Arbitrary browser JS execution is agent work. Create a task — the spawned agent runs JS from its worktree.',
  'mcp__chrome-bridge__reload_chrome_extension':
    'Extension reload is agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__wake_extension':
    'Extension wake is agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__resize_window':
    'Window resize is agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__switch_browser':
    'Browser switching is agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__shortcuts_execute':
    'Keyboard shortcuts are agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__tabs_create_mcp':
    'Tab creation is agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__update_plan':
    'Plan updates via chrome-bridge are agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__upload_image':
    'Image uploads are agent work. Create a task — the spawned agent handles it.',
  'mcp__chrome-bridge__gif_creator':
    'GIF creation is agent work. Create a task — the spawned agent handles it.',
};

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
    // Read CTO worktree path from config and verify the directory still exists.
    // When the recorded worktree was deleted, deny messages must NOT suggest cd-ing into it.
    //
    // Per-session lookup: prefer ctoWorktreePaths[event.session_id] over the legacy
    // singular ctoWorktreePath. Multiple concurrent CTO sessions each have their own
    // worktree under .claude/worktrees/cto-interactive-<sid8>/.
    let ctoWorktreePath = '';
    let worktreeExists = false;
    let ctoWorktreePathsRegistry = null;
    const eventSessionId = event?.session_id || event?.sessionId || '';
    try {
      const configPath = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.ctoWorktreePaths && typeof config.ctoWorktreePaths === 'object') {
        ctoWorktreePathsRegistry = config.ctoWorktreePaths;
        if (eventSessionId) {
          ctoWorktreePath = config.ctoWorktreePaths[eventSessionId] || '';
        }
      }
      if (!ctoWorktreePath) {
        ctoWorktreePath = config.ctoWorktreePath || '';
      }
      worktreeExists = !!ctoWorktreePath && fs.existsSync(ctoWorktreePath);
    } catch { /* non-fatal */ }

    // Task-tool sub-agent detection. Sub-agents spawned via the Task tool share
    // the interactive CTO's process (and thus inherit process.env without
    // CLAUDE_SPAWNED_SESSION set), but each has its own session_id. The
    // ctoWorktreePaths registry only contains interactive ROOT session IDs
    // (populated by authorization-audit-spawner.js on /lockdown off). When the
    // event's session_id is set AND the registry has entries AND this session
    // is NOT in the registry, the caller is a Task sub-agent — fast-exit
    // approve so it does not receive the LOCKDOWN OFF guidance addressed to
    // the interactive root. Other guards (main-tree-commit-guard,
    // credential-file-guard, worktree-path-guard, etc.) still fire because
    // they do not gate on lockdown state.
    if (
      eventSessionId &&
      ctoWorktreePathsRegistry &&
      Object.keys(ctoWorktreePathsRegistry).length > 0 &&
      !Object.prototype.hasOwnProperty.call(ctoWorktreePathsRegistry, eventSessionId)
    ) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      return;
    }

    // Build a consistent recovery block. Three states:
    //   1. Worktree exists → "cd <path> && retry"
    //   2. Worktree path set but directory missing → recovery: re-provision
    //   3. No worktree path → recovery: provision via /lockdown cycle
    const recoveryLines = (action) => {
      const isGitAction = action === 'git command';
      const pushRescueHint = isGitAction
        ? [
            '',
            `If you have ALREADY COMMITTED to a feature branch in this main tree and need to PUSH it:`,
            `  git push origin <branch-name>     (named-branch push works from ANY worktree — the branch ref is shared in .git/)`,
            `  → run that from inside any worktree cwd (cto-interactive or any .claude/worktrees/* dir).`,
            '',
            `If the main tree has UNCOMMITTED work you need to salvage:`,
            `  mcp__agent-tracker__repair_main_tree_drift({ dry_run: true })  → preview the rescue plan`,
            `  mcp__agent-tracker__repair_main_tree_drift()                    → enqueues a rescue agent that commits the orphaned work to a draft PR (never auto-merges, never force-pushes)`,
            '',
            `Toggling /lockdown does NOT enable or change task spawning, push, or any of the above — \`create_task\` + \`force_spawn_tasks\` work in BOTH lockdown states. Lockdown gates interactive-session edit/spawn permissions only; main-tree git block is an independent guard.`,
          ]
        : [];

      if (worktreeExists) {
        return [
          `Recovery: cd ${ctoWorktreePath} && <re-run your ${action}>`,
          `The worktree is a checkout of preview — your changes land on a feature branch.`,
          ...pushRescueHint,
        ];
      }
      if (ctoWorktreePath) {
        return [
          `Recovery: the recorded CTO worktree (${ctoWorktreePath}) was deleted.`,
          `Recreate it: git -C ${PROJECT_DIR} worktree add ${ctoWorktreePath} preview`,
          `Then: cd ${ctoWorktreePath} && <re-run your ${action}>`,
          ...pushRescueHint,
        ];
      }
      return [
        `Recovery: no CTO worktree provisioned. Two options:`,
        `  (a) Spawn a sub-agent with isolation: "worktree" via the Task tool (preferred for code changes)`,
        `  (b) Toggle lockdown to provision a worktree: /lockdown on, then /lockdown off (CTO must re-approve)`,
        ...pushRescueHint,
      ];
    };

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
        // Classify the target to produce a recovery message the agent can act on.
        // Three cases: (a) outside project (scratch file), (b) main tree while cwd
        // is in a worktree (the common confusion — agent used absolute main-tree path
        // when it should have used the worktree path), (c) main tree from main-tree cwd.
        const isInProject = filePath.startsWith(PROJECT_DIR + path.sep);
        const cwd = process.cwd();
        const cwdInWorktree = cwd.startsWith(worktreesDir + path.sep);

        let reason;
        if (!isInProject) {
          // Scratch path outside the project (e.g. /tmp/pr-body.md). Not actually a
          // "main-tree edit" — point at .claude/tmp/ as the project-local scratch location.
          const scratchHint = path.join(PROJECT_DIR, '.claude', 'tmp', path.basename(filePath));
          reason = [
            'BLOCKED: Writes outside the project directory are not allowed in lockdown-off mode.',
            '',
            `Target:  ${filePath}`,
            `Project: ${PROJECT_DIR}`,
            '',
            'Scratch files (PR bodies, temp JSON, etc.) must live inside the project so the audit',
            'trail captures them. Write into .claude/tmp/ instead — it is whitelisted and works with',
            'tools like `gh pr create --body-file`.',
            '',
            `Recovery: write to ${scratchHint}`,
          ].join('\n');
        } else if (cwdInWorktree) {
          // Agent is already in a worktree, but passed a main-tree absolute path.
          // Compute the worktree-local path so the recovery is one copy-paste away.
          const cwdRel = path.relative(worktreesDir, cwd);
          const worktreeName = cwdRel.split(path.sep)[0];
          const currentWorktree = path.join(worktreesDir, worktreeName);
          const relFromProject = path.relative(PROJECT_DIR, filePath);
          const correctedPath = path.join(currentWorktree, relFromProject);
          const cwdRelativePath = path.relative(cwd, correctedPath);
          reason = [
            'BLOCKED: Path resolves to the main tree, but your cwd is already in a worktree.',
            '',
            `Target:    ${filePath}`,
            `Your cwd:  ${cwd}`,
            '',
            'The absolute path you used points OUTSIDE your worktree — it would edit the live',
            "main-tree copy instead of the worktree's copy. Use the worktree path:",
            '',
            `  ${correctedPath}`,
            '',
            `(Or pass it relative to your cwd: ${cwdRelativePath})`,
            '',
            'Why: main-tree edits conflict with running agents and break the merge chain.',
            'Other guards (main-tree-commit-guard, block-no-verify) are not affected by /lockdown.',
          ].join('\n');
        } else {
          // cwd is not in a worktree — likely main tree itself. Direct the agent to a worktree.
          reason = [
            'BLOCKED: Main-tree edits are not allowed (this restriction is INDEPENDENT of lockdown state).',
            '',
            'Why: editing main-tree files conflicts with running agents and breaks the merge chain.',
            'Allowed paths: .claude/worktrees/**, .claude/**, ~/.claude/**',
            '',
            ...recoveryLines('edit'),
            '',
            'Note: external worktrees (e.g. `git worktree add /tmp/foo`) are NOT recognized — worktrees',
            'must live under .claude/worktrees/ to be allowed by this guard.',
            '',
            'Other guards (main-tree-commit-guard, block-no-verify) are not affected by /lockdown.',
          ].join('\n');
        }
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

    // Block dangerous git commands in the main tree — mutations must happen in the worktree
    if (toolName === 'Bash') {
      const command = event?.tool_input?.command || '';
      const cwd = process.cwd();
      const worktreesDir = path.join(PROJECT_DIR, '.claude', 'worktrees');
      const isInWorktree = cwd.startsWith(worktreesDir + path.sep);

      if (!isInWorktree && command) {
        const BLOCKED_GIT_PATTERNS = [
          /\bgit\s+stash\b/,
          /\bgit\s+checkout\b/,
          /\bgit\s+switch\b/,
          /\bgit\s+merge\b/,
          /\bgit\s+pull\b/,
          /\bgit\s+rebase\b/,
          /\bgit\s+reset\b/,
          /\bgit\s+clean\b/,
          /\bgit\s+add\b/,
          /\bgit\s+commit\b/,
          /\bgit\s+push\b/,
          /\bgit\s+worktree\s+remove\b/,
        ];

        for (const pattern of BLOCKED_GIT_PATTERNS) {
          if (pattern.test(command)) {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: [
                  `BLOCKED: Git mutations are not allowed in the main tree (INDEPENDENT of lockdown state).`,
                  '',
                  `Allowed in main tree: git log, diff, status, show, branch, remote, ls-remote, fetch, worktree list/add.`,
                  '',
                  ...recoveryLines('git command'),
                  '',
                  `Note: /lockdown does NOT unblock this. Disabling lockdown only widens edit permissions; main-tree git mutations remain blocked.`,
                ].join('\n'),
              },
            }));
            return;
          }
        }
      }
    }

    // Approve all other tools with workflow guidance
    const worktreeStatus = worktreeExists
      ? `Worktree: ${ctoWorktreePath}`
      : ctoWorktreePath
        ? `Worktree MISSING: ${ctoWorktreePath} (recreate: git worktree add ${ctoWorktreePath} preview)`
        : 'No worktree provisioned — toggle /lockdown on then off to provision';
    const pipelineReminder = worktreeExists
      ? `YOUR PIPELINE: run ONE 6-step sequence at a time here via Task(subagent_type=..., cwd=${ctoWorktreePath}) — investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager. All six share that worktree (do NOT use isolation: "worktree"). Only step 6 (project-manager) commits/pushes/merges. After merge, pnpm demo:preview in the main tree hot-reloads automatically. ONE pipeline at a time in this session — do NOT fan out parallel Tasks A/B/C concurrently in this terminal; they share this cwd and step 6 will collide on git checkout/merge (project-manager refuses with a worktree-lock-busy error). For parallel work, open another \`claude\` terminal — PR #709 gives each interactive session its own cto-interactive-<sid8> worktree, fully isolated.`
      : 'YOUR PIPELINE: run ONE 6-step sequence at a time here via Task(subagent_type=..., cwd=<worktree>) — investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager. All six share the worktree; only step 6 commits/pushes/merges. ONE pipeline at a time — for parallel work, open another `claude` terminal instead of fanning out Tasks (they share this cwd and trample at step 6).';
    const guidance = [
      '[LOCKDOWN OFF] Your direct main-tree edits + git mutations are BLOCKED. Worktree workflow active.',
      pipelineReminder,
      worktreeStatus,
      'Async alternatives (only when the user explicitly wants async): /spawn-tasks, /persistent-task, /plan.',
      'When the user is done: /lockdown on re-enables lockdown and removes the worktree.',
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
        ? `\n\nIf the CTO explicitly authorizes you to run this directly: Deferred action ${deferred.id} — call record_cto_decision({ decision_type: "lockdown_toggle", decision_id: "${deferred.id}", verbatim_text: "<CTO exact words>" }). The action will auto-execute after approval. **Do not request this casually — the default is to delegate.**`
        : '';

      const guidance = MCP_DELEGATION_GUIDANCE[toolName];
      const reasonBody = guidance
        ? `Deputy-CTO console: \`${toolName}\` is agent work, not management.\n\n${guidance}`
        : `Deputy-CTO console: \`${toolName}\` is not available in interactive mode.\n\nThis MCP tool is for infrastructure management. Create a task to delegate this work to an agent.`;

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${reasonBody}${deferredMsg}`,
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
