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
import * as os from 'os';
import { fileURLToPath } from 'url';
import { spawn, execSync, execFileSync } from 'child_process';

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
// AGENT TRACKER IMPORT
// ---------------------------------------------------------------------------

let registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES;

async function loadAgentTracker(projectDir) {
  const trackerPath = path.join(projectDir, '.claude', 'hooks', 'agent-tracker.js');
  if (!fs.existsSync(trackerPath)) {
    const frameworkTracker = path.resolve(__dirname, '..', '.claude', 'hooks', 'agent-tracker.js');
    if (fs.existsSync(frameworkTracker)) {
      const mod = await import(frameworkTracker);
      registerSpawn = mod.registerSpawn;
      updateAgent = mod.updateAgent;
      AGENT_TYPES = mod.AGENT_TYPES;
      HOOK_TYPES = mod.HOOK_TYPES;
      return;
    }
    throw new Error(`agent-tracker.js not found at ${trackerPath}`);
  }
  const mod = await import(trackerPath);
  registerSpawn = mod.registerSpawn;
  updateAgent = mod.updateAgent;
  AGENT_TYPES = mod.AGENT_TYPES;
  HOOK_TYPES = mod.HOOK_TYPES;
}

// ---------------------------------------------------------------------------
// CREDENTIAL CACHE (duplicated from force-spawn-tasks.js)
// ---------------------------------------------------------------------------

let resolvedCredentials = {};
let credentialsResolved = false;

function ensureCredentials(projectDir) {
  if (credentialsResolved) return;
  credentialsResolved = true;
  preResolveCredentials(projectDir);
}

function preResolveCredentials(projectDir) {
  const hasServiceAccount = !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const isLaunchdService = process.env.GENTYR_LAUNCHD_SERVICE === 'true';

  if (isLaunchdService && !hasServiceAccount) {
    return;
  }

  const mappingsPath = path.join(projectDir, '.claude', 'vault-mappings.json');
  const actionsPath = path.join(projectDir, '.claude', 'hooks', 'protected-actions.json');

  let mappings = {};
  let servers = {};

  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    mappings = data.mappings || {};
  } catch {
    return;
  }

  try {
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    servers = actions.servers || {};
  } catch {
    return;
  }

  const allKeys = new Set();
  for (const server of Object.values(servers)) {
    if (server.credentialKeys) {
      for (const key of server.credentialKeys) {
        allKeys.add(key);
      }
    }
  }

  for (const key of allKeys) {
    if (process.env[key]) continue;

    const ref = mappings[key];
    if (!ref) continue;

    if (ref.startsWith('op://')) {
      try {
        const value = execFileSync('op', ['read', ref], {
          encoding: 'utf-8',
          timeout: 15000,
          stdio: 'pipe',
        }).trim();

        if (value) {
          resolvedCredentials[key] = value;
        }
      } catch {
        // Skip failed credential resolution
      }
    } else {
      resolvedCredentials[key] = ref;
    }
  }
}

function buildSpawnEnv(agentId, projectDir) {
  ensureCredentials(projectDir);
  return {
    ...process.env,
    ...resolvedCredentials,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_SPAWNED_SESSION: 'true',
    CLAUDE_AGENT_ID: agentId,
  };
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
      "pgrep -cf 'claude.*--dangerously-skip-permissions'",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// SESSION ID DISCOVERY
// ---------------------------------------------------------------------------

function getSessionDir(projectDir) {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

function discoverSessionId(projectDir, spawnTimeMs) {
  const sessionDir = getSessionDir(projectDir);
  if (!fs.existsSync(sessionDir)) return null;

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  try {
    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return { name: f, mtime: stat.mtimeMs, size: stat.size };
      })
      .filter(f => {
        const id = f.name.replace('.jsonl', '');
        return UUID_REGEX.test(id) && f.mtime >= spawnTimeMs;
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;
    return files[0].name.replace('.jsonl', '');
  } catch {
    return null;
  }
}

function pollForSessionId(projectDir, spawnTimeMs, maxWaitMs = 3000, intervalMs = 500) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const sessionId = discoverSessionId(projectDir, spawnTimeMs);
    if (sessionId) return sessionId;

    // Synchronous sleep via busy-wait with Atomics for minimal CPU
    const waitMs = Math.min(intervalMs, deadline - Date.now());
    if (waitMs > 0) {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      } catch {
        // Fallback: busy-wait
        const end = Date.now() + waitMs;
        while (Date.now() < end) { /* spin */ }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// TRIAGE PROMPT BUILDER
// ---------------------------------------------------------------------------

function buildTriagePrompt(agentId) {
  return `[Task][report-triage][AGENT:${agentId}] You are an orchestrator performing REPORT TRIAGE.

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
  section: "CODE-REVIEWER",  // Choose based on task type (see section mapping below)
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

Section mapping for self-handled tasks:
- Code changes (full agent sequence) → "CODE-REVIEWER"
- Research/analysis only → "INVESTIGATOR & PLANNER"
- Test creation/updates → "TEST-WRITER"
- Documentation/cleanup → "PROJECT-MANAGER"
- Orchestration/delegation → "DEPUTY-CTO"

**If ESCALATING:**
\`\`\`
// Add to CTO queue with context
mcp__deputy-cto__add_question({
  type: "escalation",  // or "decision" if CTO needs to choose
  title: "Brief title of the issue",
  description: "Context from investigation + why CTO input needed",
  suggested_options: ["Option A", "Option B"],  // if applicable
  recommendation: "Your recommended course of action and why"  // REQUIRED for escalations
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
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  // Load dependencies
  await loadDatabase();
  await loadAgentTracker(config.projectDir);

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

  // Register spawn
  const agentId = registerSpawn({
    type: AGENT_TYPES.DEPUTY_CTO_REVIEW,
    hookType: HOOK_TYPES.HOURLY_AUTOMATION,
    description: `Force-triage: deputy-cto - ${pendingReports} pending reports`,
    prompt: '',
    metadata: { source: 'force-triage-reports', pendingReports },
  });

  // Build prompt with embedded agent ID
  const prompt = buildTriagePrompt(agentId);

  // Store the prompt
  if (updateAgent) {
    updateAgent(agentId, { prompt });
  }

  // Record spawn time for session discovery
  const spawnTimeMs = Date.now();

  // Spawn detached claude process
  try {
    const mcpConfig = path.join(config.projectDir, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: config.projectDir,
      env: buildSpawnEnv(agentId, config.projectDir),
    });

    claude.unref();

    // Store PID
    if (updateAgent) {
      updateAgent(agentId, { pid: claude.pid, status: 'running' });
    }

    // Poll for session ID
    const sessionId = pollForSessionId(config.projectDir, spawnTimeMs);

    console.log(JSON.stringify({
      agentId,
      pid: claude.pid,
      sessionId,
      pendingReports,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      agentId,
      pid: null,
      sessionId: null,
      pendingReports,
      error: `Spawn failed: ${err.message}`,
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
