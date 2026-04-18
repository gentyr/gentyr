#!/usr/bin/env node
/**
 * Force Triage Reports
 *
 * Standalone script that force-spawns a deputy-CTO triage agent immediately,
 * bypassing the hourly automation's triage check interval and cooldowns.
 *
 * Called by the /triage slash command via the agent-tracker MCP tool.
 *
 * Usage:
 *   node scripts/force-triage-reports.js --project-dir /path/to/project
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-dir' && args[i + 1]) {
      result.projectDir = args[++i];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// AGENT TRACKER + SESSION QUEUE IMPORT
// ---------------------------------------------------------------------------

let AGENT_TYPES, HOOK_TYPES;
let enqueueSession;

async function loadAgentTracker(projectDir) {
  const trackerPath = path.join(projectDir, '.claude', 'hooks', 'agent-tracker.js');
  if (!fs.existsSync(trackerPath)) {
    const frameworkTracker = path.resolve(__dirname, '..', '.claude', 'hooks', 'agent-tracker.js');
    if (fs.existsSync(frameworkTracker)) {
      const mod = await import(frameworkTracker);
      AGENT_TYPES = mod.AGENT_TYPES;
      HOOK_TYPES = mod.HOOK_TYPES;
      return;
    }
    throw new Error(`agent-tracker.js not found at ${trackerPath}`);
  }
  const mod = await import(trackerPath);
  AGENT_TYPES = mod.AGENT_TYPES;
  HOOK_TYPES = mod.HOOK_TYPES;
}

async function loadSessionQueue(projectDir) {
  const queuePath = path.join(projectDir, '.claude', 'hooks', 'lib', 'session-queue.js');
  if (!fs.existsSync(queuePath)) {
    const frameworkQueue = path.resolve(__dirname, '..', '.claude', 'hooks', 'lib', 'session-queue.js');
    if (fs.existsSync(frameworkQueue)) {
      const mod = await import(frameworkQueue);
      enqueueSession = mod.enqueueSession;
      return;
    }
    throw new Error(`session-queue.js not found at ${queuePath}`);
  }
  const mod = await import(queuePath);
  enqueueSession = mod.enqueueSession;
}

// ---------------------------------------------------------------------------
// DB HELPERS
// ---------------------------------------------------------------------------

let Database = null;

async function loadDatabase() {
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    // Non-fatal but will prevent report count queries
  }
}

function countPendingReports(ctoReportsDbPath) {
  if (!Database || !fs.existsSync(ctoReportsDbPath)) return 0;

  try {
    const db = new Database(ctoReportsDbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'pending'").get();
    db.close();
    return row?.cnt || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CONCURRENCY CHECK
// ---------------------------------------------------------------------------

function countRunningAgents() {
  try {
    const result = execSync(
      "pgrep -f 'claude.*--dangerously-skip-permissions' 2>/dev/null | wc -l",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// TRIAGE PROMPT BUILDER
// ---------------------------------------------------------------------------

function buildTriagePrompt(agentId) {
  return `[Automation][report-triage][AGENT:${agentId}] You are an orchestrator performing REPORT TRIAGE.

## IMMEDIATE ACTION

Your first action MUST be to spawn the deputy-cto sub-agent:
\`\`\`
Task(subagent_type='deputy-cto', prompt='Triage all pending agent reports. Use mcp__agent-reports__get_reports_for_triage to get reports, then investigate and decide on each.')
\`\`\`

The deputy-cto sub-agent has specialized instructions loaded from .claude/agents/deputy-cto.md.

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
// Create an urgent task — dispatched immediately by the urgent dispatcher
mcp__todo-db__create_task({
  category_id: "standard",  // Choose based on task type (see category mapping below)
  title: "Brief actionable title",
  description: "Full context: what to fix, where, why, and acceptance criteria",
  assigned_by: "deputy-cto",
  priority: "urgent"
})

// Complete the triage
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "self_handled",
  outcome: "Created urgent task to [brief description of fix]"
})
\`\`\`

Category mapping for self-handled tasks:
- Code changes (full agent sequence) → category_id: "standard"
- Research/analysis only → category_id: "deep-investigation"
- Test creation/updates → category_id: "test-suite"
- Documentation/cleanup → category_id: "project-management"
- Orchestration/delegation → category_id: "triage"

**If ESCALATING:**

Before escalating, check for duplicate investigations:
\`\`\`
// Check for existing investigations on the same issue
mcp__todo-db__list_tasks({ category_id: "deep-investigation", status: "pending" })
// If a similar investigation task already exists, skip Step 1 and link to the existing task ID instead
\`\`\`

Then follow the investigation-before-escalation flow:
\`\`\`
// Step 1: Create investigation task (returns task_id)
const investigationTask = mcp__todo-db__create_task({
  category_id: "deep-investigation",
  title: "Investigate: <brief issue description>",
  description: "Context from triage: <what was found, where, reproduction steps>\n\nAcceptance criteria:\n- Determine root cause\n- Verify if issue is still active\n- Document findings",
  assigned_by: "deputy-cto",
  priority: "urgent",
  followup_section: "triage",
  followup_prompt: "[Investigation Follow-up]\nEscalation ID: <question_id from Step 2>\n\nInstructions:\n1. Read the escalation via mcp__deputy-cto__read_question(id)\n   - If not found or already answered, mark this follow-up complete (CTO already handled it)\n2. Check current state of the issue\n3. If resolved: call mcp__deputy-cto__resolve_question({ id, resolution: 'fixed', resolution_detail: '<evidence>' })\n4. If not resolved but has findings: call mcp__deputy-cto__update_question({ id, append_context: '<findings>' })\n5. Mark this follow-up task complete"
})

// Step 2: Create escalation with investigation link
mcp__deputy-cto__add_question({
  type: "escalation",  // or "decision" if CTO needs to choose
  title: "Brief title of the issue",
  description: "Context from investigation + why CTO input needed",
  suggested_options: ["Option A", "Option B"],  // if applicable
  recommendation: "Your recommended course of action and why",  // REQUIRED for escalations
  investigation_task_id: investigationTask.task_id  // Links escalation to investigation
})

// Step 3: Complete the triage
mcp__agent-reports__complete_triage({
  id: "<report-id>",
  status: "escalated",
  outcome: "Escalated with investigation task: [brief description]"
})
\`\`\`

IMPORTANT: Update the followup_prompt's "Escalation ID" placeholder with the actual question ID returned from Step 2's add_question call.

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
}

// ---------------------------------------------------------------------------
// DEDUP HELPERS (G011)
// ---------------------------------------------------------------------------

/**
 * Check if a process is still alive (G011 dedup - PID liveness validation).
 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = test existence without killing
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a currently-running triage agent (G011 idempotency check).
 * Validates PID liveness to handle stale entries where agent crashed but wasn't reaped.
 */
function findRunningTriageAgent(history) {
  const agents = history?.agents || [];
  return agents.find(
    a => a.type === AGENT_TYPES.DEPUTY_CTO_REVIEW
      && a.status === 'running'
      && isPidAlive(a.pid)
  ) || null;
}

/**
 * Read the agent tracker history file directly (readHistory is not exported from agent-tracker.js).
 */
function readTrackerHistory(projectDir) {
  const historyFile = path.join(projectDir, '.claude', 'state', 'agent-tracker-history.json');
  if (!fs.existsSync(historyFile)) {
    return { agents: [] };
  }
  try {
    const content = fs.readFileSync(historyFile, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) {
      return { agents: [] };
    }
    return parsed;
  } catch {
    return { agents: [] };
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  // Load dependencies
  await loadDatabase();
  await loadAgentTracker(config.projectDir);
  await loadSessionQueue(config.projectDir);

  const ctoReportsDbPath = path.join(config.projectDir, '.claude', 'cto-reports.db');
  const pendingReports = countPendingReports(ctoReportsDbPath);

  if (pendingReports === 0) {
    console.log(JSON.stringify({
      agentId: null,
      pid: null,
      sessionId: null,
      pendingReports: 0,
      message: 'No pending reports to triage',
    }));
    process.exit(0);
  }

  // G011: Check for already-running triage agent (idempotency)
  const triageHistory = readTrackerHistory(config.projectDir);
  const existingTriage = findRunningTriageAgent(triageHistory);

  if (existingTriage) {
    const result = {
      agentId: existingTriage.id,
      pid: existingTriage.pid || null,
      sessionId: null,
      pendingReports,
      message: `Triage agent already running (${existingTriage.id}). Skipping duplicate spawn.`,
      deduplicated: true,
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  // Reap completed agents before counting to free slots
  try {
    const { reapCompletedAgents } = await import('./reap-completed-agents.js');
    reapCompletedAgents(config.projectDir);
  } catch {
    // Non-fatal
  }

  // Check concurrency
  const runningAgents = countRunningAgents();
  const automationConfigPath = path.join(config.projectDir, '.claude', 'state', 'automation-config.json');
  let maxConcurrent = 10;
  try {
    const automationConfig = JSON.parse(fs.readFileSync(automationConfigPath, 'utf8'));
    maxConcurrent = automationConfig?.effective?.MAX_CONCURRENT_AGENTS ?? 10;
  } catch {
    // Use default
  }

  if (runningAgents >= maxConcurrent) {
    console.log(JSON.stringify({
      agentId: null,
      pid: null,
      sessionId: null,
      pendingReports,
      message: `Concurrency limit reached (${runningAgents}/${maxConcurrent}). Cannot spawn triage agent.`,
    }));
    process.exit(0);
  }

  // Enqueue the triage session — the queue handles registerSpawn, buildSpawnEnv, and spawn internally.
  try {
    const { queueId } = enqueueSession({
      title: `Force-triage: deputy-cto - ${pendingReports} pending reports`,
      agentType: AGENT_TYPES.DEPUTY_CTO_REVIEW,
      hookType: HOOK_TYPES.HOURLY_AUTOMATION,
      tagContext: 'report-triage',
      source: 'force-triage-reports',
      buildPrompt: (agentId) => buildTriagePrompt(agentId),
      cwd: config.projectDir,
      projectDir: config.projectDir,
      priority: 'urgent',
      metadata: { source: 'force-triage-reports', pendingReports },
      ttlMs: 30 * 60 * 1000,
    });

    console.log(JSON.stringify({
      agentId: null,
      pid: null,
      sessionId: null,
      pendingReports,
      queueId,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      agentId: null,
      pid: null,
      sessionId: null,
      pendingReports,
      error: `Enqueue failed: ${err.message}`,
    }));
    process.exit(1);
  }
}

main().catch((err) => {
  console.log(JSON.stringify({
    agentId: null,
    pid: null,
    sessionId: null,
    pendingReports: 0,
    error: `Fatal error: ${err.message}`,
  }));
  process.exit(1);
});
