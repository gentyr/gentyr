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
import { runFeedbackPipeline } from './feedback-orchestrator.js';

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
    claudeMdRefactorEnabled: true,
    lintCheckerEnabled: true,
    taskRunnerEnabled: true,
    standaloneAntipatternHunterEnabled: true,
    standaloneComplianceCheckerEnabled: true,
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
 * Check CTO activity gate.
 * G001: Fail-closed - if lastCtoBriefing is missing or older than 24h, automation is gated.
 *
 * @returns {{ open: boolean, reason: string, hoursSinceLastBriefing: number | null }}
 */
function checkCtoActivityGate(config) {
  const lastCtoBriefing = config.lastCtoBriefing;

  if (!lastCtoBriefing) {
    return {
      open: false,
      reason: 'No CTO briefing recorded. Run /deputy-cto to activate automation.',
      hoursSinceLastBriefing: null,
    };
  }

  try {
    const briefingTime = new Date(lastCtoBriefing).getTime();
    if (isNaN(briefingTime)) {
      return {
        open: false,
        reason: 'CTO briefing timestamp is invalid. Run /deputy-cto to reset.',
        hoursSinceLastBriefing: null,
      };
    }

    const hoursSince = (Date.now() - briefingTime) / (1000 * 60 * 60);
    if (hoursSince >= 24) {
      return {
        open: false,
        reason: `CTO briefing was ${Math.floor(hoursSince)}h ago (>24h). Run /deputy-cto to reactivate.`,
        hoursSinceLastBriefing: Math.floor(hoursSince),
      };
    }

    return {
      open: true,
      reason: `CTO briefing was ${Math.floor(hoursSince)}h ago. Gate is open.`,
      hoursSinceLastBriefing: Math.floor(hoursSince),
    };
  } catch (err) {
    // G001: Parse error = fail closed
    return {
      open: false,
      reason: `Failed to parse CTO briefing timestamp: ${err.message}`,
      hoursSinceLastBriefing: null,
    };
  }
}

/**
 * Get state
 * G001: Fail-closed if state file is corrupted
 */
function getState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastRun: 0, lastClaudeMdRefactor: 0, lastTriageCheck: 0, lastTaskRunnerCheck: 0,
      lastPreviewPromotionCheck: 0, lastStagingPromotionCheck: 0,
      lastStagingHealthCheck: 0, lastProductionHealthCheck: 0,
      lastStandaloneAntipatternHunt: 0, lastStandaloneComplianceCheck: 0,
      lastFeedbackCheck: 0, lastFeedbackSha: null,
    };
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
 * Query todo.db for ALL pending tasks older than 1 hour.
 * Each task gets its own Claude session. No section limits.
 */
function getPendingTasksForRunner() {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) {
    return [];
  }

  try {
    const db = new Database(TODO_DB_PATH, { readonly: true });
    const nowTimestamp = Math.floor(Date.now() / 1000);
    const oneHourAgo = nowTimestamp - 3600;

    const candidates = db.prepare(`
      SELECT id, section, title, description
      FROM tasks
      WHERE status = 'pending'
        AND section IN (${Object.keys(SECTION_AGENT_MAP).map(() => '?').join(',')})
        AND created_timestamp <= ?
      ORDER BY created_timestamp ASC
    `).all(...Object.keys(SECTION_AGENT_MAP), oneHourAgo);

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

// =========================================================================
// PROMOTION & HEALTH MONITOR SPAWN FUNCTIONS
// =========================================================================

/**
 * Check if a git branch exists on the remote
 */
function remoteBranchExists(branch) {
  try {
    execSync(`git rev-parse --verify origin/${branch}`, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get commits on source not yet in target
 */
function getNewCommits(source, target) {
  try {
    const result = execSync(`git log origin/${target}..origin/${source} --oneline`, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();
    return result ? result.split('\n') : [];
  } catch {
    return [];
  }
}

/**
 * Get Unix timestamp of last commit on a branch
 */
function getLastCommitTimestamp(branch) {
  try {
    const result = execSync(`git log origin/${branch} -1 --format=%ct`, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if any commit messages contain bug-fix keywords
 */
function hasBugFixCommits(commits) {
  const bugFixPattern = /\b(fix|bug|hotfix|patch|critical)\b/i;
  return commits.some(line => bugFixPattern.test(line));
}

/**
 * Spawn Preview -> Staging promotion orchestrator
 */
function spawnPreviewPromotion(newCommits, hoursSinceLastStagingMerge, hasBugFix) {
  const commitList = newCommits.join('\n');

  const prompt = `[Task][preview-promotion] You are the PREVIEW -> STAGING Promotion Pipeline orchestrator.

## Mission

Evaluate whether commits on the \`preview\` branch are ready to be promoted to \`staging\`.

## Context

**New commits on preview (not in staging):**
\`\`\`
${commitList}
\`\`\`

**Hours since last staging merge:** ${hoursSinceLastStagingMerge}
**Bug-fix commits detected:** ${hasBugFix ? 'YES (24h waiting period bypassed)' : 'No'}

## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review the commits:
- Check for security issues, code quality, spec violations
- Look for disabled tests, placeholder code, hardcoded credentials
- Verify no spec violations (G001-G019)

### Step 2: Test Assessment

Spawn a test-writer sub-agent (Task tool, subagent_type: test-writer) to assess test quality:
- Check if new code has adequate test coverage
- Verify no tests were disabled or weakened

### Step 3: Evaluate Results

If EITHER agent reports issues:
- Report findings via mcp__cto-reports__report_to_cto with category "decision", priority "normal"
- Create TODO tasks for fixes
- Do NOT proceed with promotion
- Output: "Promotion blocked: [reasons]"

### Step 4: Deputy-CTO Decision

If both agents pass, spawn a deputy-cto sub-agent (Task tool, subagent_type: deputy-cto) with:
- The review results from both agents
- The commit list
- Request: Evaluate stability and decide whether to promote

The deputy-cto should:
- **If approving**: Call \`mcp__deputy-cto__spawn_implementation_task\` with this prompt:
  \`\`\`
  Create a PR from preview to staging and merge it after CI passes:
  1. Run: gh pr create --base staging --head preview --title "Promote preview to staging" --body "Automated promotion. Commits: ${newCommits.length} new commits. Reviewed by code-reviewer and test-writer agents."
  2. Wait for CI: gh pr checks <number> --watch
  3. If CI passes: gh pr merge <number> --merge
  4. If CI fails: Report failure via mcp__cto-reports__report_to_cto
  \`\`\`
- **If rejecting**: Report issues via mcp__cto-reports__report_to_cto, create TODO tasks

## Timeout

Complete within 25 minutes. If blocked, report and exit.

## Output

Summarize the promotion decision and actions taken.`;

  const agentId = registerSpawn({
    type: AGENT_TYPES.PREVIEW_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Preview -> Staging promotion pipeline',
    prompt: prompt,
    metadata: { commitCount: newCommits.length, hoursSinceLastStagingMerge, hasBugFix },
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
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
        CLAUDE_AGENT_ID: agentId,
      },
    });

    return new Promise((resolve, reject) => {
      claude.on('close', (code) => {
        resolve({ code, output: '(output sent to inherit stdio)' });
      });
      claude.on('error', (err) => reject(err));
      setTimeout(() => {
        claude.kill();
        reject(new Error('Preview promotion timed out after 30 minutes'));
      }, 30 * 60 * 1000);
    });
  } catch (err) {
    log(`Preview promotion spawn error: ${err.message}`);
    return Promise.resolve({ code: 1, output: err.message });
  }
}

/**
 * Spawn Staging -> Production promotion orchestrator
 */
function spawnStagingPromotion(newCommits, hoursSinceLastStagingCommit) {
  const commitList = newCommits.join('\n');

  const prompt = `[Task][staging-promotion] You are the STAGING -> PRODUCTION Promotion Pipeline orchestrator.

## Mission

Evaluate whether commits on the \`staging\` branch are ready to be promoted to \`main\` (production).

## Context

**New commits on staging (not in main):**
\`\`\`
${commitList}
\`\`\`

**Hours since last staging commit:** ${hoursSinceLastStagingCommit} (must be >= 24 for stability)

## Process

### Step 1: Code Review

Spawn a code-reviewer sub-agent (Task tool, subagent_type: code-reviewer) to review all staging commits:
- Full security audit
- Spec compliance check (G001-G019)
- No placeholder code, disabled tests, or hardcoded credentials

### Step 2: Test Assessment

Spawn a test-writer sub-agent (Task tool, subagent_type: test-writer) to assess:
- Test coverage meets thresholds (80% global, 100% critical paths)
- No tests disabled or weakened

### Step 3: Evaluate Results

If EITHER agent reports issues:
- Report via mcp__cto-reports__report_to_cto with priority "high"
- Create TODO tasks for fixes
- Do NOT proceed with promotion
- Output: "Production promotion blocked: [reasons]"

### Step 4: Deputy-CTO Decision

If both agents pass, spawn a deputy-cto sub-agent (Task tool, subagent_type: deputy-cto) with:
- The review results from both agents
- The commit list
- Request: Create the production release PR and CTO decision task

The deputy-cto should:
1. Call \`mcp__deputy-cto__spawn_implementation_task\` to create the PR:
   \`\`\`
   gh pr create --base main --head staging --title "Production Release: ${newCommits.length} commits" --body "Automated production promotion. Staging stable for ${hoursSinceLastStagingCommit}h. Reviewed by code-reviewer and test-writer."
   \`\`\`

2. Call \`mcp__deputy-cto__add_question\` with:
   - type: "approval"
   - title: "Production Release: Merge staging -> main (${newCommits.length} commits)"
   - description: Include review results, commit list, stability assessment
   - suggested_options: ["Approve merge to production", "Reject - needs more work"]

3. Report via mcp__cto-reports__report_to_cto

**CTO approval**: When CTO approves via /deputy-cto, deputy-cto calls spawn_implementation_task to merge:
\`gh pr merge <number> --merge\`

## Timeout

Complete within 25 minutes. If blocked, report and exit.

## Output

Summarize the promotion decision and actions taken.`;

  const agentId = registerSpawn({
    type: AGENT_TYPES.STAGING_PROMOTION,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Staging -> Production promotion pipeline',
    prompt: prompt,
    metadata: { commitCount: newCommits.length, hoursSinceLastStagingCommit },
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
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        CLAUDE_SPAWNED_SESSION: 'true',
        CLAUDE_AGENT_ID: agentId,
      },
    });

    return new Promise((resolve, reject) => {
      claude.on('close', (code) => {
        resolve({ code, output: '(output sent to inherit stdio)' });
      });
      claude.on('error', (err) => reject(err));
      setTimeout(() => {
        claude.kill();
        reject(new Error('Staging promotion timed out after 30 minutes'));
      }, 30 * 60 * 1000);
    });
  } catch (err) {
    log(`Staging promotion spawn error: ${err.message}`);
    return Promise.resolve({ code: 1, output: err.message });
  }
}

/**
 * Spawn Staging Health Monitor (fire-and-forget)
 */
function spawnStagingHealthMonitor() {
  const prompt = `[Task][staging-health-monitor] You are the STAGING Health Monitor.

## Mission

Check all deployment infrastructure for staging environment health. Query services, check for errors, and report any issues found.

## Process

### Step 1: Read Service Configuration

Read \`.claude/config/services.json\` to get Render staging service ID and Vercel project ID.
If the file doesn't exist, report this as an issue and exit.

### Step 2: Check Render Staging

- Use \`mcp__render__render_get_service\` with the staging service ID for service status
- Use \`mcp__render__render_list_deploys\` to check for recent deploy failures
- Flag: service down, deploy failures, stuck deploys

### Step 3: Check Vercel Staging

- Use \`mcp__vercel__vercel_list_deployments\` for recent staging deployments
- Flag: build failures, deployment errors

### Step 4: Query Elasticsearch for Errors

- Use \`mcp__elastic-logs__query_logs\` with query: \`level:error\`, from: \`now-3h\`, to: \`now\`
- Use \`mcp__elastic-logs__get_log_stats\` grouped by service for error counts
- Flag: error spikes, new error types, critical errors

### Step 5: Compile Health Report

**If issues found:**
1. Call \`mcp__cto-reports__report_to_cto\` with:
   - reporting_agent: "staging-health-monitor"
   - title: "Staging Health Issue: [summary]"
   - summary: Full findings
   - category: "performance" or "blocker" based on severity
   - priority: "normal" or "high" based on severity

2. For actionable issues, call \`mcp__deputy-cto__spawn_implementation_task\` with:
   - Detailed prompt describing the issue and how to fix it
   - Include all relevant context (error messages, service IDs, etc.)

**If all clear:**
- Log "Staging environment healthy" and exit

## Timeout

Complete within 10 minutes. This is a read-only monitoring check.`;

  const agentId = registerSpawn({
    type: AGENT_TYPES.STAGING_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Staging health monitor check',
    prompt: prompt,
    metadata: {},
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
    log(`Staging health monitor spawn error: ${err.message}`);
    return false;
  }
}

/**
 * Spawn Production Health Monitor (fire-and-forget)
 */
function spawnProductionHealthMonitor() {
  const prompt = `[Task][production-health-monitor] You are the PRODUCTION Health Monitor.

## Mission

Check all deployment infrastructure for production environment health. This is CRITICAL -- production issues must be escalated to both deputy-CTO and CTO.

## Process

### Step 1: Read Service Configuration

Read \`.claude/config/services.json\` to get Render production service ID and Vercel project ID.
If the file doesn't exist, report this as an issue and exit.

### Step 2: Check Render Production

- Use \`mcp__render__render_get_service\` with the production service ID for service status
- Use \`mcp__render__render_list_deploys\` to check for recent deploy failures
- Flag: service down, deploy failures, stuck deploys

### Step 3: Check Vercel Production

- Use \`mcp__vercel__vercel_list_deployments\` for recent production deployments
- Flag: build failures, deployment errors

### Step 4: Query Elasticsearch for Errors

- Use \`mcp__elastic-logs__query_logs\` with query: \`level:error\`, from: \`now-1h\`, to: \`now\`
- Use \`mcp__elastic-logs__get_log_stats\` grouped by service for error counts
- Flag: error spikes, new error types, critical errors

### Step 5: Compile Health Report

**If issues found:**
1. Call \`mcp__cto-reports__report_to_cto\` with:
   - reporting_agent: "production-health-monitor"
   - title: "PRODUCTION Health Issue: [summary]"
   - summary: Full findings
   - category: "performance" or "blocker" based on severity
   - priority: "high" or "critical" based on severity

2. Call \`mcp__deputy-cto__add_question\` with:
   - type: "escalation"
   - title: "Production Health Issue: [summary]"
   - description: Full health report findings
   - This creates a CTO decision task visible in /deputy-cto

3. For actionable issues, call \`mcp__deputy-cto__spawn_implementation_task\` with:
   - Detailed prompt describing the issue and how to fix it
   - Include all relevant context (error messages, service IDs, etc.)

**If all clear:**
- Log "Production environment healthy" and exit

## Timeout

Complete within 10 minutes. This is a read-only monitoring check.`;

  const agentId = registerSpawn({
    type: AGENT_TYPES.PRODUCTION_HEALTH_MONITOR,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Production health monitor check',
    prompt: prompt,
    metadata: {},
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
    log(`Production health monitor spawn error: ${err.message}`);
    return false;
  }
}

/**
 * Get random spec file for standalone compliance checker
 * Reads specs/global/*.md and specs/local/*.md, returns a random one
 */
function getRandomSpec() {
  const specsDir = path.join(PROJECT_DIR, 'specs');
  const specs = [];

  for (const subdir of ['global', 'local']) {
    const dir = path.join(specsDir, subdir);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const f of files) {
        specs.push({ path: `specs/${subdir}/${f}`, id: f.replace('.md', '') });
      }
    }
  }

  if (specs.length === 0) return null;
  return specs[Math.floor(Math.random() * specs.length)];
}

/**
 * Spawn Standalone Antipattern Hunter (fire-and-forget)
 * Scans entire codebase for spec violations, independent of git hooks
 */
function spawnStandaloneAntipatternHunter() {
  const prompt = `[Task][standalone-antipattern-hunter] STANDALONE ANTIPATTERN HUNT - Periodic repo-wide scan for spec violations.

You are a STANDALONE antipattern hunter running on a 3-hour schedule. Your job is to systematically scan
the ENTIRE codebase looking for spec violations and technical debt.

## Your Focus Areas
- Hunt across ALL directories: src/, packages/, products/, integrations/
- Look for systemic patterns of violations
- Prioritize high-severity specs (G001, G004, G009, G010, G016)

## Workflow

### Step 1: Load Specifications
\`\`\`javascript
mcp__specs-browser__list_specs({})
mcp__specs-browser__get_spec({ spec_id: "G001" })  // No graceful fallbacks
mcp__specs-browser__get_spec({ spec_id: "G004" })  // No hardcoded credentials
mcp__specs-browser__get_spec({ spec_id: "G009" })  // RLS policies required
mcp__specs-browser__get_spec({ spec_id: "G010" })  // Session auth validation
mcp__specs-browser__get_spec({ spec_id: "G016" })  // Integration boundary
\`\`\`

### Step 2: Hunt for Violations
Use Grep to systematically scan for violation patterns:
- G001: \`|| null\`, \`|| undefined\`, \`?? 0\`, \`|| []\`, \`|| {}\`
- G002: \`TODO\`, \`FIXME\`, \`throw new Error('Not implemented')\`
- G004: Hardcoded API keys, credentials, secrets
- G011: \`MOCK_MODE\`, \`isSimulation\`, \`isMockMode\`

### Step 3: For Each Violation
a. Create TODO item:
   \`\`\`javascript
   mcp__todo-db__create_task({
     section: "CODE-REVIEWER",
     title: "Fix [SPEC-ID] violation in [file]",
     description: "[Details and location]",
     assigned_by: "STANDALONE-ANTIPATTERN-HUNTER"
   })
   \`\`\`

### Step 4: Report Critical Issues to CTO
Report when you find:
- Security violations (G004 hardcoded credentials, G009 missing RLS, G010 missing auth)
- Architecture boundary violations (cross-product separation)
- Critical spec violations requiring immediate attention
- Patterns of repeated violations (3+ similar issues)

\`\`\`javascript
mcp__cto-reports__report_to_cto({
  reporting_agent: "standalone-antipattern-hunter",
  title: "Brief title (max 200 chars)",
  summary: "Detailed summary with file paths, line numbers, and severity (max 2000 chars)",
  category: "security" | "architecture" | "performance" | "other",
  priority: "low" | "normal" | "high" | "critical"
})
\`\`\`

### Step 5: END SESSION
After creating TODO items and CTO reports, provide a summary and END YOUR SESSION.
Do NOT implement fixes yourself.

Focus on finding SYSTEMIC issues across the codebase, not just isolated violations.`;

  const agentId = registerSpawn({
    type: AGENT_TYPES.STANDALONE_ANTIPATTERN_HUNTER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: 'Standalone antipattern hunt (3h schedule)',
    prompt: prompt,
    metadata: {},
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
    log(`Standalone antipattern hunter spawn error: ${err.message}`);
    return false;
  }
}

/**
 * Spawn Standalone Compliance Checker (fire-and-forget)
 * Picks a random spec and scans the codebase for violations of that specific spec
 */
function spawnStandaloneComplianceChecker(spec) {
  const prompt = `[Task][standalone-compliance-checker] STANDALONE COMPLIANCE CHECK - Audit codebase against spec: ${spec.id}

You are a STANDALONE compliance checker running on a 1-hour schedule. You have been assigned ONE specific spec to audit the codebase against.

## Your Assigned Spec

**Spec ID:** ${spec.id}
**Spec Path:** ${spec.path}

## Workflow

### Step 1: Load Your Assigned Spec
\`\`\`javascript
mcp__specs-browser__get_spec({ spec_id: "${spec.id}" })
\`\`\`

Read the spec thoroughly. Understand every requirement, constraint, and rule it defines.

### Step 2: Systematically Scan the Codebase
Based on the spec requirements:
1. Use Grep to search for patterns that violate the spec
2. Use Glob to find files that should comply with the spec
3. Read relevant files to check for compliance
4. Focus on areas most likely to have violations

### Step 3: For Each Violation Found
Create a TODO item:
\`\`\`javascript
mcp__todo-db__create_task({
  section: "CODE-REVIEWER",
  title: "Fix ${spec.id} violation in [file]:[line]",
  description: "[Violation details and what the spec requires]",
  assigned_by: "STANDALONE-COMPLIANCE-CHECKER"
})
\`\`\`

### Step 4: Report Critical Issues
If you find critical violations (security, data exposure, architectural), report to CTO:
\`\`\`javascript
mcp__cto-reports__report_to_cto({
  reporting_agent: "standalone-compliance-checker",
  title: "${spec.id} compliance issue: [summary]",
  summary: "Detailed findings with file paths and line numbers",
  category: "security" | "architecture" | "other",
  priority: "normal" | "high" | "critical"
})
\`\`\`

### Step 5: END SESSION
Provide a compliance summary:
- Total files checked
- Violations found (count and severity)
- Overall compliance status for ${spec.id}

Do NOT implement fixes yourself. Only report and create TODOs.`;

  const agentId = registerSpawn({
    type: AGENT_TYPES.STANDALONE_COMPLIANCE_CHECKER,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: `Standalone compliance check: ${spec.id}`,
    prompt: prompt,
    metadata: { specId: spec.id, specPath: spec.path },
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
    log(`Standalone compliance checker spawn error: ${err.message}`);
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

  // CTO Activity Gate: require /deputy-cto within last 24h
  const ctoGate = checkCtoActivityGate(config);
  if (!ctoGate.open) {
    log(`CTO Activity Gate CLOSED: ${ctoGate.reason}`);
    registerHookExecution({
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      status: 'skipped',
      durationMs: Date.now() - startTime,
      metadata: { reason: 'cto_activity_gate_closed', hoursSinceLastBriefing: ctoGate.hoursSinceLastBriefing }
    });
    process.exit(0);
  }

  log(`Autonomous Deputy CTO Mode is ENABLED. ${ctoGate.reason}`);

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
  const PREVIEW_PROMOTION_COOLDOWN_MS = getCooldown('preview_promotion', 360) * 60 * 1000;
  const STAGING_PROMOTION_COOLDOWN_MS = getCooldown('staging_promotion', 1200) * 60 * 1000;
  const STAGING_HEALTH_COOLDOWN_MS = getCooldown('staging_health_monitor', 180) * 60 * 1000;
  const PRODUCTION_HEALTH_COOLDOWN_MS = getCooldown('production_health_monitor', 60) * 60 * 1000;
  const STANDALONE_ANTIPATTERN_COOLDOWN_MS = getCooldown('standalone_antipattern_hunter', 180) * 60 * 1000;
  const STANDALONE_COMPLIANCE_COOLDOWN_MS = getCooldown('standalone_compliance_checker', 60) * 60 * 1000;
  const USER_FEEDBACK_COOLDOWN_MS = getCooldown('user_feedback', 120) * 60 * 1000;

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
  // TASK RUNNER CHECK (1h cooldown)
  // Spawns a separate Claude session for every pending TODO item >1h old
  // =========================================================================
  const TASK_RUNNER_COOLDOWN_MS = getCooldown('task_runner', 60) * 60 * 1000;
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
  // PREVIEW -> STAGING PROMOTION (6h cooldown)
  // Checks for new commits on preview, spawns review + promotion pipeline
  // =========================================================================
  const timeSinceLastPreviewPromotion = now - (state.lastPreviewPromotionCheck || 0);
  const previewPromotionEnabled = config.previewPromotionEnabled !== false;

  if (timeSinceLastPreviewPromotion >= PREVIEW_PROMOTION_COOLDOWN_MS && previewPromotionEnabled) {
    log('Preview promotion: checking for promotable commits...');

    try {
      // Fetch latest remote state
      execSync('git fetch origin preview staging --quiet 2>/dev/null || true', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
    } catch {
      log('Preview promotion: git fetch failed, skipping.');
    }

    if (remoteBranchExists('preview') && remoteBranchExists('staging')) {
      const newCommits = getNewCommits('preview', 'staging');

      if (newCommits.length === 0) {
        log('Preview promotion: no new commits on preview.');
      } else {
        const lastStagingTimestamp = getLastCommitTimestamp('staging');
        const hoursSinceLastStagingMerge = lastStagingTimestamp > 0
          ? Math.floor((Date.now() / 1000 - lastStagingTimestamp) / 3600) : 999;
        const hasBugFix = hasBugFixCommits(newCommits);

        if (hoursSinceLastStagingMerge >= 24 || hasBugFix) {
          log(`Preview promotion: ${newCommits.length} commits ready. Staging age: ${hoursSinceLastStagingMerge}h. Bug fix: ${hasBugFix}.`);

          try {
            const result = await spawnPreviewPromotion(newCommits, hoursSinceLastStagingMerge, hasBugFix);
            if (result.code === 0) {
              log('Preview promotion pipeline completed successfully.');
            } else {
              log(`Preview promotion pipeline exited with code ${result.code}`);
            }
          } catch (err) {
            log(`Preview promotion error: ${err.message}`);
          }
        } else {
          log(`Preview promotion: ${newCommits.length} commits pending but staging only ${hoursSinceLastStagingMerge}h old (need 24h or bug fix).`);
        }
      }
    } else {
      log('Preview promotion: preview or staging branch does not exist on remote.');
    }

    state.lastPreviewPromotionCheck = now;
    saveState(state);
  } else if (!previewPromotionEnabled) {
    log('Preview Promotion is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((PREVIEW_PROMOTION_COOLDOWN_MS - timeSinceLastPreviewPromotion) / 60000);
    log(`Preview promotion cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // STAGING -> PRODUCTION PROMOTION (midnight window, 20h cooldown)
  // Checks nightly for stable staging to promote to production
  // =========================================================================
  const timeSinceLastStagingPromotion = now - (state.lastStagingPromotionCheck || 0);
  const stagingPromotionEnabled = config.stagingPromotionEnabled !== false;
  const currentHour = new Date().getHours();
  const currentMinute = new Date().getMinutes();
  const isMidnightWindow = currentHour === 0 && currentMinute <= 30;

  if (isMidnightWindow && timeSinceLastStagingPromotion >= STAGING_PROMOTION_COOLDOWN_MS && stagingPromotionEnabled) {
    log('Staging promotion: midnight window - checking for promotable commits...');

    try {
      execSync('git fetch origin staging main --quiet 2>/dev/null || true', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
    } catch {
      log('Staging promotion: git fetch failed, skipping.');
    }

    if (remoteBranchExists('staging') && remoteBranchExists('main')) {
      const newCommits = getNewCommits('staging', 'main');

      if (newCommits.length === 0) {
        log('Staging promotion: no new commits on staging.');
      } else {
        const lastStagingTimestamp = getLastCommitTimestamp('staging');
        const hoursSinceLastStagingCommit = lastStagingTimestamp > 0
          ? Math.floor((Date.now() / 1000 - lastStagingTimestamp) / 3600) : 0;

        if (hoursSinceLastStagingCommit >= 24) {
          log(`Staging promotion: ${newCommits.length} commits ready. Staging stable for ${hoursSinceLastStagingCommit}h.`);

          try {
            const result = await spawnStagingPromotion(newCommits, hoursSinceLastStagingCommit);
            if (result.code === 0) {
              log('Staging promotion pipeline completed successfully.');
            } else {
              log(`Staging promotion pipeline exited with code ${result.code}`);
            }
          } catch (err) {
            log(`Staging promotion error: ${err.message}`);
          }
        } else {
          log(`Staging promotion: staging only ${hoursSinceLastStagingCommit}h old (need 24h stability).`);
        }
      }
    } else {
      log('Staging promotion: staging or main branch does not exist on remote.');
    }

    state.lastStagingPromotionCheck = now;
    saveState(state);
  } else if (!stagingPromotionEnabled) {
    log('Staging Promotion is disabled in config.');
  } else if (!isMidnightWindow) {
    // Only log this at debug level since it runs every 10 minutes
  } else {
    const minutesLeft = Math.ceil((STAGING_PROMOTION_COOLDOWN_MS - timeSinceLastStagingPromotion) / 60000);
    log(`Staging promotion cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // STAGING HEALTH MONITOR (3h cooldown, fire-and-forget)
  // Checks staging infrastructure health
  // =========================================================================
  const timeSinceLastStagingHealth = now - (state.lastStagingHealthCheck || 0);
  const stagingHealthEnabled = config.stagingHealthMonitorEnabled !== false;

  if (timeSinceLastStagingHealth >= STAGING_HEALTH_COOLDOWN_MS && stagingHealthEnabled) {
    try {
      execSync('git fetch origin staging --quiet 2>/dev/null || true', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
    } catch {
      log('Staging health monitor: git fetch failed.');
    }

    if (remoteBranchExists('staging')) {
      log('Staging health monitor: spawning health check...');
      const success = spawnStagingHealthMonitor();
      if (success) {
        log('Staging health monitor: spawned (fire-and-forget).');
      } else {
        log('Staging health monitor: spawn failed.');
      }
    } else {
      log('Staging health monitor: staging branch does not exist, skipping.');
    }

    state.lastStagingHealthCheck = now;
    saveState(state);
  } else if (!stagingHealthEnabled) {
    log('Staging Health Monitor is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((STAGING_HEALTH_COOLDOWN_MS - timeSinceLastStagingHealth) / 60000);
    log(`Staging health monitor cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // PRODUCTION HEALTH MONITOR (1h cooldown, fire-and-forget)
  // Checks production infrastructure health, escalates to CTO
  // =========================================================================
  const timeSinceLastProdHealth = now - (state.lastProductionHealthCheck || 0);
  const prodHealthEnabled = config.productionHealthMonitorEnabled !== false;

  if (timeSinceLastProdHealth >= PRODUCTION_HEALTH_COOLDOWN_MS && prodHealthEnabled) {
    log('Production health monitor: spawning health check...');
    const success = spawnProductionHealthMonitor();
    if (success) {
      log('Production health monitor: spawned (fire-and-forget).');
    } else {
      log('Production health monitor: spawn failed.');
    }

    state.lastProductionHealthCheck = now;
    saveState(state);
  } else if (!prodHealthEnabled) {
    log('Production Health Monitor is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((PRODUCTION_HEALTH_COOLDOWN_MS - timeSinceLastProdHealth) / 60000);
    log(`Production health monitor cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // STANDALONE ANTIPATTERN HUNTER (3h cooldown, fire-and-forget)
  // Repo-wide spec violation scan, independent of git hooks
  // =========================================================================
  const timeSinceLastAntipatternHunt = now - (state.lastStandaloneAntipatternHunt || 0);
  const antipatternHuntEnabled = config.standaloneAntipatternHunterEnabled !== false;

  if (timeSinceLastAntipatternHunt >= STANDALONE_ANTIPATTERN_COOLDOWN_MS && antipatternHuntEnabled) {
    log('Standalone antipattern hunter: spawning repo-wide scan...');
    const success = spawnStandaloneAntipatternHunter();
    if (success) {
      log('Standalone antipattern hunter: spawned (fire-and-forget).');
    } else {
      log('Standalone antipattern hunter: spawn failed.');
    }

    state.lastStandaloneAntipatternHunt = now;
    saveState(state);
  } else if (!antipatternHuntEnabled) {
    log('Standalone Antipattern Hunter is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((STANDALONE_ANTIPATTERN_COOLDOWN_MS - timeSinceLastAntipatternHunt) / 60000);
    log(`Standalone antipattern hunter cooldown active. ${minutesLeft} minutes until next hunt.`);
  }

  // =========================================================================
  // STANDALONE COMPLIANCE CHECKER (1h cooldown, fire-and-forget)
  // Picks a random spec and audits the codebase against it
  // =========================================================================
  const timeSinceLastComplianceCheck = now - (state.lastStandaloneComplianceCheck || 0);
  const complianceCheckEnabled = config.standaloneComplianceCheckerEnabled !== false;

  if (timeSinceLastComplianceCheck >= STANDALONE_COMPLIANCE_COOLDOWN_MS && complianceCheckEnabled) {
    const randomSpec = getRandomSpec();
    if (randomSpec) {
      log(`Standalone compliance checker: spawning audit for spec ${randomSpec.id}...`);
      const success = spawnStandaloneComplianceChecker(randomSpec);
      if (success) {
        log(`Standalone compliance checker: spawned for ${randomSpec.id} (fire-and-forget).`);
      } else {
        log('Standalone compliance checker: spawn failed.');
      }
    } else {
      log('Standalone compliance checker: no specs found in specs/global/ or specs/local/.');
    }

    state.lastStandaloneComplianceCheck = now;
    saveState(state);
  } else if (!complianceCheckEnabled) {
    log('Standalone Compliance Checker is disabled in config.');
  } else {
    const minutesLeft = Math.ceil((STANDALONE_COMPLIANCE_COOLDOWN_MS - timeSinceLastComplianceCheck) / 60000);
    log(`Standalone compliance checker cooldown active. ${minutesLeft} minutes until next check.`);
  }

  // =========================================================================
  // USER FEEDBACK PIPELINE (2h cooldown, fire-and-forget agents)
  // Detects staging changes, matches personas, spawns feedback agents
  // =========================================================================
  const userFeedbackEnabled = config.userFeedbackEnabled !== false;

  if (userFeedbackEnabled) {
    try {
      const feedbackResult = await runFeedbackPipeline(log, state, saveState, USER_FEEDBACK_COOLDOWN_MS);
      if (feedbackResult.ran) {
        log(`User feedback: ${feedbackResult.reason}`);
        registerSpawn({
          type: AGENT_TYPES.FEEDBACK_ORCHESTRATOR,
          hookType: HOOK_TYPES.HOURLY_AUTOMATION,
          description: feedbackResult.reason,
          prompt: '',
          metadata: { personasTriggered: feedbackResult.personasTriggered },
        });
      } else {
        log(`User feedback: skipped - ${feedbackResult.reason}`);
      }
    } catch (err) {
      log(`User feedback pipeline error (non-fatal): ${err.message}`);
    }
  } else {
    log('User Feedback Pipeline is disabled in config.');
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
