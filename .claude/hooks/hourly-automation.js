#!/usr/bin/env node
/**
 * Hourly Automation Runner
 *
 * Wrapper script called by systemd/launchd hourly service.
 * Delegates to individual automation scripts based on config.
 *
 * This design allows changing behavior without re-installing the service.
 *
 * Automations:
 * 1. Plan Executor - Execute pending project plans
 * 2. CLAUDE.md Refactor - Compact CLAUDE.md when it exceeds size threshold
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { registerSpawn, registerHookExecution, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { getCooldown } from './config-reader.js';
import { runUsageOptimizer } from './usage-optimizer.js';

// Try to import better-sqlite3 for task runner
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  // Non-fatal: task runner will be skipped if unavailable
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_FILE = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'hourly-automation.log');
const STATE_FILE = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const CTO_REPORTS_DB = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');

// Thresholds
const CLAUDE_MD_SIZE_THRESHOLD = 25000; // 25K characters
// Note: Per-item cooldown (1 hour) is now handled by the agent-reports MCP server

// Task Runner: section-to-agent mapping
const SECTION_AGENT_MAP = {
  'CODE-REVIEWER': { agent: 'code-reviewer', agentType: AGENT_TYPES.TASK_RUNNER_CODE_REVIEWER },
  'INVESTIGATOR & PLANNER': { agent: 'investigator', agentType: AGENT_TYPES.TASK_RUNNER_INVESTIGATOR },
  'TEST-WRITER': { agent: 'test-writer', agentType: AGENT_TYPES.TASK_RUNNER_TEST_WRITER },
  'PROJECT-MANAGER': { agent: 'project-manager', agentType: AGENT_TYPES.TASK_RUNNER_PROJECT_MANAGER },
};
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');

/**
 * Append to log file
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
  console.log(logLine.trim());
}

/**
 * Get config (autonomous mode settings)
 *
 * G001 Note: If config is corrupted, we use safe defaults (enabled: false).
 * This is intentional fail-safe behavior - corrupt config should NOT enable automation.
 * The corruption is logged prominently for CTO awareness.
 */
function getConfig() {
  const defaults = {
    enabled: false,
    planExecutorEnabled: true,
    claudeMdRefactorEnabled: true,
    lintCheckerEnabled: true,
    taskRunnerEnabled: true,
    lastModified: null,
  };

  if (!fs.existsSync(CONFIG_FILE)) {
    return defaults;
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...defaults, ...config };
  } catch (err) {
    // G001: Config corruption is logged but we fail-safe to disabled mode
    // This is intentional - corrupt config should never enable automation
    log(`ERROR: Config file corrupted - automation DISABLED for safety: ${err.message}`);
    log(`Fix: Delete or repair ${CONFIG_FILE}`);
    return defaults;
  }
}

/**
 * Get state
 * G001: Fail-closed if state file is corrupted
 */
function getState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastRun: 0, lastClaudeMdRefactor: 0, lastTriageCheck: 0, lastTaskRunnerCheck: 0 };
  }

  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Migration for existing state files
    if (state.lastTriageCheck === undefined) {
      state.lastTriageCheck = state.lastTriage || 0;
      delete state.lastTriage;
    }
    // Remove legacy triageAttempts if present (now handled by MCP server)
    delete state.triageAttempts;
    return state;
  } catch (err) {
    log(`FATAL: State file corrupted: ${err.message}`);
    log(`Delete ${STATE_FILE} to reset.`);
    process.exit(1);
  }
}

/**
 * Save state
 * G001: Fail-closed if state can't be saved
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`FATAL: Cannot save state: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Check CLAUDE.md size
 */
function getClaudeMdSize() {
  const claudeMdPath = path.join(PROJECT_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    return 0;
  }

  try {
    const stats = fs.statSync(claudeMdPath);
    return stats.size;
  } catch {
    return 0;
  }
}

/**
 * Check if there are any reports ready for triage
 * Uses simple sqlite3 query - MCP server handles cooldown filtering
 */
function hasReportsReadyForTriage() {
  if (!fs.existsSync(CTO_REPORTS_DB)) {
    return false;
  }

  try {
    // Quick check for any pending reports
    // The MCP server's get_reports_for_triage handles cooldown filtering
    const result = execSync(
      `sqlite3 "${CTO_REPORTS_DB}" "SELECT COUNT(*) FROM reports WHERE triage_status = 'pending'"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    return parseInt(result, 10) > 0;
  } catch (err) {
    log(`WARN: Failed to check for pending reports: ${err.message}`);
    return false;
  }
}

/**
 * Spawn deputy-cto to triage pending reports
 * The agent will discover reports via MCP tools (which handle cooldown filtering)
 */
function spawnReportTriage() {
  const prompt = `[Task][report-triage] You are the deputy-cto performing REPORT TRIAGE.

## Mission

Triage all pending agent reports that are ready (past cooldown). For each report:
1. Investigate to understand the context
2. Decide whether to handle it yourself, escalate to CTO, or dismiss
3. Take appropriate action

## Step 1: Get Reports Ready for Triage

\`\`\`
mcp__agent-reports__get_reports_for_triage({ limit: 10 })
\`\`\`

This returns reports that are:
- Status = pending
- Past the 1-hour per-item cooldown (if previously attempted)

If no reports are returned, output "No reports ready for triage" and exit.

## Step 2: Triage Each Report

For each report from the list above:

### 2a: Start Triage
\`\`\`
mcp__agent-reports__start_triage({ id: "<report-id>" })
\`\`\`

### 2b: Read the Report
\`\`\`
mcp__agent-reports__read_report({ id: "<report-id>" })
\`\`\`

### 2c: Investigate

**Search for related work:**
\`\`\`
mcp__todo-db__list_tasks({ limit: 50 })  // Check current tasks
mcp__deputy-cto__search_cleared_items({ query: "<keywords from report>" })  // Check past CTO items
mcp__agent-tracker__search_sessions({ query: "<keywords>", limit: 10 })  // Search session history
\`\`\`

**If needed, search the codebase:**
- Use Grep to find related code
- Use Read to examine specific files mentioned in the report

### 2d: Check Auto-Escalation Rules

**ALWAYS ESCALATE (no exceptions):**
- **G002 Violations**: Any report mentioning stub code, placeholder, TODO, FIXME, or "not implemented"
- **Security vulnerabilities**: Any report with category "security" or mentioning vulnerabilities
- **Bypass requests**: Any bypass-request type (these require CTO approval)

If the report matches ANY auto-escalation rule, skip to "If ESCALATING" - do not self-handle or dismiss.

### 2e: Apply Decision Framework (if no auto-escalation)

| ESCALATE to CTO | SELF-HANDLE | DISMISS |
|-----------------|-------------|---------|
| Breaking change to users | Issue already in todos | Already resolved |
| Architectural decision needed | Similar issue recently fixed | Not a real problem |
| Resource/budget implications | Clear fix, low risk | False positive |
| Cross-team coordination | Obvious code quality fix | Duplicate report |
| Uncertain about approach | Documentation/test gap | Informational only |
| High priority + ambiguity | Performance fix clear path | Outdated concern |
| Policy/process change | Routine maintenance | |
| | Isolated bug fix | |

**Decision Rules:**
- **>80% confident** you know the right action → self-handle
- **<80% confident** OR sensitive → escalate
- **Not actionable** (already fixed, false positive, duplicate) → dismiss

### 2f: Take Action

**If SELF-HANDLING:**
\`\`\`
// Spawn a task to address the issue
mcp__deputy-cto__spawn_implementation_task({
  prompt: "Detailed instructions for what to fix/implement...",
  description: "Brief description (max 100 chars)"
})

// Complete the triage
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "self_handled",
  outcome: "Spawned task to [brief description of fix]"
})
\`\`\`

**If ESCALATING:**
\`\`\`
// Add to CTO queue with context
mcp__deputy-cto__add_question({
  type: "escalation",  // or "decision" if CTO needs to choose
  title: "Brief title of the issue",
  description: "Context from investigation + why CTO input needed",
  suggested_options: ["Option A", "Option B"]  // if applicable
})

// Complete the triage
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "escalated",
  outcome: "Escalated: [reason CTO input is needed]"
})
\`\`\`

**If DISMISSING:**
\`\`\`
// Complete the triage - no further action needed
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "dismissed",
  outcome: "Dismissed: [reason - e.g., already resolved, not actionable, duplicate]"
})
\`\`\`

**IMPORTANT: Only dismiss when you have clear evidence** the issue is not actionable.
If in doubt, escalate instead.

## Question Types for Escalation

Use the appropriate type when calling \`add_question\`:
- \`decision\` - CTO needs to choose between options
- \`approval\` - CTO needs to approve a proposed action
- \`question\` - Seeking CTO guidance/input
- \`escalation\` - Raising awareness of an issue

## IMPORTANT

- Process ALL reports returned by get_reports_for_triage
- Always call \`start_triage\` before investigating
- Always call \`complete_triage\` when done
- Be thorough in investigation but efficient in execution
- When self-handling, the spawned task prompt should be detailed enough to succeed independently

## Output

After processing all reports, output a summary:
- How many self-handled vs escalated vs dismissed
- Brief description of each action taken`;

  // Register spawn with agent tracker
  const agentId = registerSpawn({
    type: AGENT_TYPES.DEPUTY_CTO_REVIEW,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Triaging pending CTO reports',
    prompt: prompt,
    metadata: {},
  });

  return new Promise((resolve, reject) => {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const spawnArgs = [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '-p',
      prompt,
    ];

    // Use stdio: 'inherit' - Claude CLI requires TTY-like environment
    // Output goes directly to parent process stdout/stderr
    const claude = spawn('claude', [...spawnArgs, '--output-format', 'json'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
        CLAUDE_AGENT_ID: agentId,
      },
    });

    claude.on('close', (code) => {
      resolve({ code, output: '(output sent to inherit stdio)' });
    });

    claude.on('error', (err) => {
      reject(err);
    });

    // 15 minute timeout for triage
    setTimeout(() => {
      claude.kill();
      reject(new Error('Report triage timed out after 15 minutes'));
    }, 15 * 60 * 1000);
  });
}

/**
 * Run a child script and wait for completion
 */
function runScript(scriptPath, description) {
  return new Promise((resolve, reject) => {
    log(`Starting: ${description}`);

    const child = spawn('node', [scriptPath], {
      cwd: PROJECT_DIR,
      stdio: 'pipe',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
      },
    });

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        log(`Completed: ${description}`);
        resolve({ code, output });
      } else {
        log(`Failed: ${description} (exit code ${code})`);
        resolve({ code, output });
      }
    });

    child.on('error', (err) => {
      log(`Error: ${description} - ${err.message}`);
      reject(err);
    });

    // 35 minute timeout per script
    setTimeout(() => {
      child.kill();
      reject(new Error(`${description} timed out after 35 minutes`));
    }, 35 * 60 * 1000);
  });
}

/**
 * Spawn Claude for CLAUDE.md refactoring
 */
function spawnClaudeMdRefactor() {
  const prompt = `[Task][claudemd-refactor] You are the deputy-cto performing CLAUDE.md REFACTORING.

## Mission

CLAUDE.md has grown beyond 25,000 characters. Your job is to carefully refactor it by:
1. Moving detailed content to sub-files in \`docs/\` or \`specs/\`
2. Replacing moved content with brief summaries and links
3. Preserving ALL information (nothing lost, just reorganized)

## CRITICAL RULE

There is a divider line "---" near the bottom of CLAUDE.md followed by:
\`\`\`
<!-- CTO-PROTECTED: Changes below this line require CTO approval -->
\`\`\`

**NEVER modify anything below that divider.** That section contains critical instructions that must remain in CLAUDE.md.

## Refactoring Strategy

1. **Read CLAUDE.md carefully** - Understand the full content
2. **Identify movable sections** - Look for:
   - Detailed code examples (move to specs/reference/)
   - Long tables (summarize, link to full version)
   - Verbose explanations (condense, link to details)
3. **Create sub-files** - Use existing directories:
   - \`specs/reference/\` for development guides
   - \`specs/local/\` for component details
   - \`docs/\` for general documentation
4. **Update CLAUDE.md** - Replace with concise summary + link
5. **Verify nothing lost** - All information must be preserved

## Example Refactor

Before:
\`\`\`markdown
## MCP Tools Reference

### Core Tools
- \`page_get_snapshot\` - Get page structure
- \`page_click\` - Click element
[... 50 more lines ...]
\`\`\`

After:
\`\`\`markdown
## MCP Tools Reference

See [specs/reference/MCP-TOOLS.md](specs/reference/MCP-TOOLS.md) for complete tool reference.

Key tools: \`page_get_snapshot\`, \`page_click\`, \`mcp__todo-db__*\`, \`mcp__specs-browser__*\`
\`\`\`

## Rate Limiting

- Make at most 5 file edits per run
- If more refactoring needed, it will continue next hour

## Start Now

1. Read CLAUDE.md
2. Identify the largest movable sections
3. Create sub-files and update CLAUDE.md
4. Report what you refactored via mcp__agent-reports__report_to_deputy_cto`;

  // Register spawn with agent tracker
  const agentId = registerSpawn({
    type: AGENT_TYPES.CLAUDEMD_REFACTOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Refactoring oversized CLAUDE.md',
    prompt: prompt,
    metadata: {},
  });

  return new Promise((resolve, reject) => {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const spawnArgs = [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '-p',
      prompt,
    ];

    // Use stdio: 'inherit' - Claude CLI requires TTY-like environment
    // Output goes directly to parent process stdout/stderr
    const claude = spawn('claude', [...spawnArgs, '--output-format', 'json'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
        CLAUDE_AGENT_ID: agentId,
      },
    });

    claude.on('close', (code) => {
      resolve({ code, output: '(output sent to inherit stdio)' });
    });

    claude.on('error', (err) => {
      reject(err);
    });

    // 30 minute timeout
    setTimeout(() => {
      claude.kill();
      reject(new Error('CLAUDE.md refactor timed out after 30 minutes'));
    }, 30 * 60 * 1000);
  });
}

/**
 * Run linter and return errors if any
 * Returns { hasErrors: boolean, output: string }
 */
function runLintCheck() {
  try {
    // Run ESLint and capture output
    const result = execSync('npm run lint 2>&1', {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 60000, // 1 minute timeout
    });

    // If we got here without throwing, there were no errors
    return { hasErrors: false, output: result };
  } catch (err) {
    // ESLint exits with non-zero code when there are errors
    // The output is in err.stdout or err.message
    const output = err.stdout || err.message || 'Unknown error';

    // Check if it's actually lint errors (not a command failure)
    if (output.includes('error') && !output.includes('Command failed')) {
      return { hasErrors: true, output: output };
    }

    // Actual command failure
    log(`WARN: Lint check failed unexpectedly: ${output.substring(0, 200)}`);
    return { hasErrors: false, output: '' };
  }
}

/**
 * Spawn Claude to fix lint errors
 */
function spawnLintFixer(lintOutput) {
  // Extract just the errors, not warnings
  const errorLines = lintOutput.split('\n')
    .filter(line => line.includes('error'))
    .slice(0, 50) // Limit to first 50 error lines
    .join('\n');

  const prompt = `[Task][lint-fixer] You are the code-reviewer agent fixing LINT ERRORS.

## Mission

The project's ESLint linter has detected errors that need to be fixed.

## Lint Errors Found

\`\`\`
${errorLines}
\`\`\`

## Process

1. **Read** the file with errors to understand the context
2. **Analyze** what the ESLint rule is complaining about
3. **Fix** the error using your judgment on the best approach
4. **Verify** by re-running the linter: \`npm run lint 2>&1 | head -100\`
5. **Iterate** until all errors are resolved (warnings are acceptable)

## Constraints

- Make at most 20 file edits per run
- If more fixes are needed, they will continue next hour
- Focus on errors only - warnings can be ignored

## When Done

Report completion via mcp__agent-reports__report_to_deputy_cto with a summary of what was fixed.`;

  // Register spawn with agent tracker
  const agentId = registerSpawn({
    type: AGENT_TYPES.LINT_FIXER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Fixing lint errors',
    prompt: prompt,
    metadata: {
      errorCount: errorLines.split('\n').length,
    },
  });

  return new Promise((resolve, reject) => {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const spawnArgs = [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '-p',
      prompt,
    ];

    // Use stdio: 'inherit' - Claude CLI requires TTY-like environment
    const claude = spawn('claude', [...spawnArgs, '--output-format', 'json'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
        CLAUDE_AGENT_ID: agentId,
      },
    });

    claude.on('close', (code) => {
      resolve({ code, output: '(output sent to inherit stdio)' });
    });

    claude.on('error', (err) => {
      reject(err);
    });

    // 20 minute timeout for lint fixing
    setTimeout(() => {
      claude.kill();
      reject(new Error('Lint fixer timed out after 20 minutes'));
    }, 20 * 60 * 1000);
  });
}

// =========================================================================
// TASK RUNNER HELPERS
// =========================================================================

/**
 * Query todo.db for the oldest pending task per section, excluding:
 * - Sections with existing in_progress tasks
 * - Tasks created < 2 minutes ago (chain reaction prevention)
 * Returns at most 1 task per section.
 */
function getPendingTasksForRunner() {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) {
    return [];
  }

  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const twoMinutesAgo = nowTimestamp - 120;

    // Get sections that already have in_progress tasks
    const busySections = db.prepare(
      "SELECT DISTINCT section FROM tasks WHERE status = 'in_progress'"
    ).all().map(r => r.section);

    // Get oldest pending task per eligible section
    const candidates = [];
    for (const section of Object.keys(SECTION_AGENT_MAP)) {
      if (busySections.includes(section)) continue;

      const task = db.prepare(`
        SELECT id, section, title, description
        FROM tasks
        WHERE status = 'pending'
          AND section = ?
          AND created_timestamp <= ?
        ORDER BY created_timestamp ASC
        LIMIT 1
      `).get(section, twoMinutesAgo);

      if (task) {
        candidates.push(task);
      }
    }

    db.close();
    return candidates;
  } catch (err) {
    log(`Task runner: DB query error: ${err.message}`);
    return [];
  }
}

/**
 * Mark a task as in_progress before spawning the agent
 */
function markTaskInProgress(taskId) {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) return false;

  try {
    const db = new Database(TODO_DB_PATH);
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ?"
    ).run(now, taskId);
    db.close();
    return true;
  } catch (err) {
    log(`Task runner: Failed to mark task ${taskId} in_progress: ${err.message}`);
    return false;
  }
}

/**
 * Reset a task back to pending on spawn failure
 */
function resetTaskToPending(taskId) {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) return;

  try {
    const db = new Database(TODO_DB_PATH);
    db.prepare(
      "UPDATE tasks SET status = 'pending', started_at = NULL WHERE id = ?"
    ).run(taskId);
    db.close();
  } catch (err) {
    log(`Task runner: Failed to reset task ${taskId}: ${err.message}`);
  }
}

/**
 * Build the prompt for a task runner agent
 */
function buildTaskRunnerPrompt(task, agentName) {
  return `[Task][task-runner-${agentName}] You are the ${agentName} agent processing a TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}

## Your Role

You are the \`${agentName}\` agent. Complete the task described above using your expertise.

## Process

1. **Understand** the task requirements from the title and description
2. **Investigate** the codebase as needed to understand context
3. **Execute** the task using appropriate tools
4. **Complete** the task by calling the MCP tool below

## When Done

You MUST call this MCP tool to mark the task as completed:

\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`

## Constraints

- Focus only on this specific task
- Do not create new tasks unless absolutely necessary
- Report any issues via mcp__agent-reports__report_to_deputy_cto`;
}

/**
 * Spawn a fire-and-forget Claude agent for a task
 */
function spawnTaskAgent(task) {
  const mapping = SECTION_AGENT_MAP[task.section];
  if (!mapping) return false;

  const prompt = buildTaskRunnerPrompt(task, mapping.agent);

  const agentId = registerSpawn({
    type: mapping.agentType,
    hookType: HOOK_TYPES.TASK_RUNNER,
    description: `Task runner: ${mapping.agent} - ${task.title}`,
    prompt: prompt,
    metadata: { taskId: task.id, section: task.section },
  });

  try {
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
        CLAUDE_AGENT_ID: agentId,
      },
    });

    claude.unref();
    return true;
  } catch (err) {
    log(`Task runner: Failed to spawn ${mapping.agent} for task ${task.id}: ${err.message}`);
    return false;
  }
}

/**
 * Main entry point
 */
async function main() {
  const startTime = Date.now();
  log('=== Hourly Automation Starting ===');

  // Check config
  const config = getConfig();

  if (!config.enabled) {
    log('Autonomous Deputy CTO Mode is DISABLED. Exiting.');
    registerHookExecution({
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'disabled' }
    });
    process.exit(0);
  }

  log('Autonomous Deputy CTO Mode is ENABLED.');

  const state = getState();
  const now = Date.now();

  // =========================================================================
  // USAGE OPTIMIZER (runs first - cheap: API call + math)
  // =========================================================================
  try {
    const optimizerResult = await runUsageOptimizer(log);
    if (optimizerResult.snapshotTaken) {
      log(`Usage optimizer: snapshot taken. Adjustment: ${optimizerResult.adjustmentMade ? 'yes' : 'no'}.`);
    }
  } catch (err) {
    log(`Usage optimizer error (non-fatal): ${err.message}`);
  }

  // Dynamic cooldowns from config
  const TRIAGE_CHECK_INTERVAL_MS = getCooldown('triage_check', 5) * 60 * 1000;
  const HOURLY_COOLDOWN_MS = getCooldown('hourly_tasks', 55) * 60 * 1000;
  const LINT_COOLDOWN_MS = getCooldown('lint_checker', 30) * 60 * 1000;

  // =========================================================================
  // TRIAGE CHECK (dynamic interval, default 5 min)
  // Per-item cooldown is handled by the MCP server's get_reports_for_triage
  // =========================================================================
  const timeSinceLastTriageCheck = now - state.lastTriageCheck;

  if (timeSinceLastTriageCheck >= TRIAGE_CHECK_INTERVAL_MS) {
    // Quick check if there are any pending reports
    if (hasReportsReadyForTriage()) {
      log('Pending reports found, spawning triage agent...');
      state.lastTriageCheck = now;
      saveState(state);

      try {
        // The agent will call get_reports_for_triage which handles cooldown filtering
        const result = await spawnReportTriage();
        if (result.code === 0) {
          log('Report triage completed successfully.');
        } else {
          log(`Report triage exited with code ${result.code}`);
        }
      } catch (err) {
        log(`Report triage error: ${err.message}`);
      }
    } else {
      log('No pending reports found.');
      state.lastTriageCheck = now;
      saveState(state);
    }
  } else {
    const minutesLeft = Math.ceil((TRIAGE_CHECK_INTERVAL_MS - timeSinceLastTriageCheck) / 60000);
    log(`Triage check cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // LINT CHECK (own cooldown, default 30 min)
  // =========================================================================
  const timeSinceLastLint = now - (state.lastLintCheck || 0);

  if (timeSinceLastLint >= LINT_COOLDOWN_MS && config.lintCheckerEnabled) {
    log('Running lint check...');
    const lintResult = runLintCheck();

    if (lintResult.hasErrors) {
      const errorCount = (lintResult.output.match(/\berror\b/gi) || []).length;
      log(`Lint check found ${errorCount} error(s), spawning fixer...`);

      try {
        const result = await spawnLintFixer(lintResult.output);
        if (result.code === 0) {
          log('Lint fixer completed successfully.');
        } else {
          log(`Lint fixer exited with code ${result.code}`);
        }
      } catch (err) {
        log(`Lint fixer error: ${err.message}`);
      }
    } else {
      log('Lint check passed - no errors found.');
    }

    state.lastLintCheck = now;
    saveState(state);
  } else if (!config.lintCheckerEnabled) {
    log('Lint Checker is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((LINT_COOLDOWN_MS - timeSinceLastLint) / 60000);
    log(`Lint check cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // TASK RUNNER CHECK (15-min cooldown)
  // Spawns agents for pending todo tasks (1 per section, max 4 concurrent)
  // =========================================================================
  const TASK_RUNNER_COOLDOWN_MS = getCooldown('task_runner', 15) * 60 * 1000;
  const timeSinceLastTaskRunner = now - (state.lastTaskRunnerCheck || 0);

  if (timeSinceLastTaskRunner >= TASK_RUNNER_COOLDOWN_MS && config.taskRunnerEnabled) {
    if (!Database) {
      log('Task runner: better-sqlite3 not available, skipping.');
    } else {
      log('Task runner: checking for pending tasks...');
      const candidates = getPendingTasksForRunner();

      if (candidates.length === 0) {
        log('Task runner: no eligible pending tasks found.');
      } else {
        log(`Task runner: found ${candidates.length} candidate task(s).`);
        let spawned = 0;

        for (const task of candidates) {
          const mapping = SECTION_AGENT_MAP[task.section];
          if (!mapping) continue;

          if (!markTaskInProgress(task.id)) {
            log(`Task runner: skipping task ${task.id} (failed to mark in_progress).`);
            continue;
          }

          const success = spawnTaskAgent(task);
          if (success) {
            log(`Task runner: spawning ${mapping.agent} for task "${task.title}" (${task.id})`);
            spawned++;
          } else {
            resetTaskToPending(task.id);
            log(`Task runner: spawn failed for task ${task.id}, reset to pending.`);
          }
        }

        log(`Task runner: spawned ${spawned} agent(s) this cycle.`);
      }
    }

    state.lastTaskRunnerCheck = now;
    saveState(state);
  } else if (!config.taskRunnerEnabled) {
    log('Task Runner is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((TASK_RUNNER_COOLDOWN_MS - timeSinceLastTaskRunner) / 60000);
    log(`Task runner cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // HOURLY TASKS (dynamic cooldown, default 55 min)
  // =========================================================================
  const timeSinceLastRun = now - state.lastRun;

  if (timeSinceLastRun < HOURLY_COOLDOWN_MS) {
    const minutesLeft = Math.ceil((HOURLY_COOLDOWN_MS - timeSinceLastRun) / 60000);
    log(`Hourly tasks cooldown active. ${minutesLeft} minutes until next run.`);
    log('=== Hourly Automation Complete ===');
    registerHookExecution({
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      status: 'success',
      durationMs: Date.now() - startTime,
      metadata: { fullRun: false, minutesUntilNext: minutesLeft }
    });
    return;
  }

  // Update state for hourly tasks
  state.lastRun = now;
  saveState(state);

  // Run plan executor if enabled
  if (config.planExecutorEnabled) {
    try {
      const planExecutorScript = path.join(__dirname, 'plan-executor.js');
      if (fs.existsSync(planExecutorScript)) {
        await runScript(planExecutorScript, 'Plan Executor');
      } else {
        log('WARN: plan-executor.js not found, skipping.');
      }
    } catch (err) {
      log(`Plan executor error: ${err.message}`);
    }
  } else {
    log('Plan Executor is disabled in config.');
  }

  // Check CLAUDE.md size and run refactor if needed
  if (config.claudeMdRefactorEnabled) {
    const claudeMdSize = getClaudeMdSize();
    log(`CLAUDE.md size: ${claudeMdSize} characters (threshold: ${CLAUDE_MD_SIZE_THRESHOLD})`);

    if (claudeMdSize > CLAUDE_MD_SIZE_THRESHOLD) {
      log('CLAUDE.md exceeds threshold, spawning refactor...');
      try {
        const result = await spawnClaudeMdRefactor();
        if (result.code === 0) {
          log('CLAUDE.md refactor completed.');
          state.lastClaudeMdRefactor = now;
          saveState(state);
        } else {
          log(`CLAUDE.md refactor exited with code ${result.code}`);
        }
      } catch (err) {
        log(`CLAUDE.md refactor error: ${err.message}`);
      }
    } else {
      log('CLAUDE.md size is within threshold.');
    }
  } else {
    log('CLAUDE.md Refactor is disabled in config.');
  }

  log('=== Hourly Automation Complete ===');

  registerHookExecution({
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    status: 'success',
    durationMs: Date.now() - startTime,
    metadata: { fullRun: true }
  });
}

main();
