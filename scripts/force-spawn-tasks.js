#!/usr/bin/env node
/**
 * Force Spawn Tasks
 *
 * Standalone script that force-spawns all pending TODO tasks immediately,
 * bypassing the hourly automation's age filter, batch limit, cooldowns,
 * and CTO activity gate.
 *
 * Called by the /spawn-tasks slash command.
 *
 * Usage:
 *   node scripts/force-spawn-tasks.js --sections "CODE-REVIEWER,TEST-WRITER" --project-dir /path/to/project
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
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
    sections: [],
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    maxConcurrent: 10,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sections' && args[i + 1]) {
      result.sections = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (args[i] === '--project-dir' && args[i + 1]) {
      result.projectDir = args[++i];
    } else if (args[i] === '--max-concurrent' && args[i + 1]) {
      const val = parseInt(args[++i], 10);
      if (val >= 1 && val <= 20) result.maxConcurrent = val;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// AGENT TRACKER IMPORT
// ---------------------------------------------------------------------------

// Resolve the agent-tracker relative to the project's .claude/hooks/
let registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES;

async function loadAgentTracker(projectDir) {
  const trackerPath = path.join(projectDir, '.claude', 'hooks', 'agent-tracker.js');
  if (!fs.existsSync(trackerPath)) {
    // Fallback: try framework-relative path
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
// DUPLICATED FROM hourly-automation.js (stable functions)
// Why: hourly-automation.js runs main() at module level — importing it
// triggers the entire automation cycle. Extracting a shared module is a
// worthy refactoring task but out of scope here.
// ---------------------------------------------------------------------------

// Task Runner: section-to-agent mapping
// Note: agentType values are enum keys resolved to AGENT_TYPES values after import
const SECTION_AGENT_MAP_KEYS = {
  'CODE-REVIEWER': { agent: 'code-reviewer', agentTypeKey: 'TASK_RUNNER_CODE_REVIEWER' },
  'INVESTIGATOR & PLANNER': { agent: 'investigator', agentTypeKey: 'TASK_RUNNER_INVESTIGATOR' },
  'TEST-WRITER': { agent: 'test-writer', agentTypeKey: 'TASK_RUNNER_TEST_WRITER' },
  'PROJECT-MANAGER': { agent: 'project-manager', agentTypeKey: 'TASK_RUNNER_PROJECT_MANAGER' },
  'DEPUTY-CTO': { agent: 'deputy-cto', agentTypeKey: 'TASK_RUNNER_DEPUTY_CTO' },
  'PRODUCT-MANAGER': { agent: 'product-manager', agentTypeKey: 'TASK_RUNNER_PRODUCT_MANAGER' },
};

// Resolved after AGENT_TYPES is loaded
let SECTION_AGENT_MAP = {};

function resolveSectionAgentMap() {
  for (const [section, { agent, agentTypeKey }] of Object.entries(SECTION_AGENT_MAP_KEYS)) {
    const agentType = AGENT_TYPES[agentTypeKey];
    if (!agentType) {
      throw new Error(`AGENT_TYPES.${agentTypeKey} not found — agent-tracker.js may have changed`);
    }
    SECTION_AGENT_MAP[section] = { agent, agentType };
  }
}

/**
 * Count running automation agents to prevent process accumulation
 */
function countRunningAgents() {
  try {
    const result = execSync(
      "pgrep -cf 'claude.*--dangerously-skip-permissions'",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    // pgrep returns exit code 1 when no processes match
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CREDENTIAL CACHE (duplicated from hourly-automation.js)
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

  // Resolve git-wrappers directory (follows symlinks for npm link model)
  const hooksDir = path.join(projectDir, '.claude', 'hooks');
  let guardedPath = process.env.PATH || '/usr/bin:/bin';
  try {
    const realHooks = fs.realpathSync(hooksDir);
    const wrappersDir = path.join(realHooks, 'git-wrappers');
    if (fs.existsSync(path.join(wrappersDir, 'git'))) {
      guardedPath = `${wrappersDir}:${guardedPath}`;
    }
  } catch {}

  return {
    ...process.env,
    ...resolvedCredentials,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_SPAWNED_SESSION: 'true',
    CLAUDE_AGENT_ID: agentId,
    PATH: guardedPath,
  };
}

// ---------------------------------------------------------------------------
// DB HELPERS (duplicated from hourly-automation.js)
// ---------------------------------------------------------------------------

let Database = null;

async function loadDatabase() {
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    // Non-fatal but will prevent task queries
  }
}

function markTaskInProgress(taskId, todoDbPath) {
  if (!Database || !fs.existsSync(todoDbPath)) return false;

  try {
    const db = new Database(todoDbPath);
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ?"
    ).run(now, taskId);
    db.close();
    return true;
  } catch {
    return false;
  }
}

function resetTaskToPending(taskId, todoDbPath) {
  if (!Database || !fs.existsSync(todoDbPath)) return;

  try {
    const db = new Database(todoDbPath);
    db.prepare(
      "UPDATE tasks SET status = 'pending', started_at = NULL WHERE id = ?"
    ).run(taskId);
    db.close();
  } catch {
    // Best-effort reset
  }
}

// ---------------------------------------------------------------------------
// PROMPT BUILDERS (duplicated from hourly-automation.js)
// ---------------------------------------------------------------------------

function buildDeputyCtoTaskPrompt(task, agentId) {
  return `[Task][task-runner-deputy-cto][AGENT:${agentId}] You are the Deputy-CTO processing a high-level task assignment.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}

## Your Mission

You are an ORCHESTRATOR. You do NOT implement tasks yourself — you evaluate, decompose, and delegate.

## Process (FOLLOW THIS ORDER)

### Step 1: Evaluate Alignment
Before doing anything, evaluate whether this task aligns with:
- The project's specs (read specs/global/ and specs/local/ as needed)
- Existing plans (check plans/ directory)
- CTO directives (check mcp__deputy-cto__list_questions for relevant decisions)

If the task does NOT align with specs, plans, or CTO requests:
- Report the misalignment via mcp__agent-reports__report_to_deputy_cto
- Mark this task complete WITHOUT creating sub-tasks
- Explain in the completion why you declined

### Step 2: Create Investigator Task FIRST
Always start by creating an urgent investigator task:
\`\`\`
mcp__todo-db__create_task({
  section: "INVESTIGATOR & PLANNER",
  title: "Investigate: ${task.title}",
  description: "You are the INVESTIGATOR. Analyze the following task and create a detailed implementation plan with specific sub-tasks:\\n\\nTask: ${task.title}\\n${task.description || ''}\\n\\nInvestigate the codebase, read relevant specs, and create TODO items in the appropriate sections via mcp__todo-db__create_task for each sub-task you identify.",
  assigned_by: "deputy-cto",
  priority: "urgent"
})
\`\`\`

### Step 3: Create Implementation Sub-Tasks
Based on your own analysis (don't wait for the investigator — it runs async), create concrete sub-tasks:

For non-urgent work (picked up by hourly automation):
\`\`\`
mcp__todo-db__create_task({
  section: "INVESTIGATOR & PLANNER",  // or CODE-REVIEWER, TEST-WRITER, PROJECT-MANAGER
  title: "Specific actionable task title",
  description: "Detailed context and acceptance criteria",
  assigned_by: "deputy-cto"
})
\`\`\`

Section mapping:
- Code changes (triggers full agent sequence: investigator → code-writer → test-writer → code-reviewer → project-manager) → CODE-REVIEWER
- Research, analysis, planning only → INVESTIGATOR & PLANNER
- Test creation/updates only → TEST-WRITER
- Documentation, cleanup only → PROJECT-MANAGER

### Step 4: Mark Complete
After all sub-tasks are created:
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
This will automatically create a follow-up verification task.

## Constraints

- Do NOT write code yourself (you have no Edit/Write/Bash tools)
- Create 3-8 specific sub-tasks per high-level task
- Each sub-task must be self-contained with enough context to execute independently
- Only delegate tasks that align with project specs and plans
- Report blockers via mcp__agent-reports__report_to_deputy_cto
- If the task needs CTO input, create a question via mcp__deputy-cto__add_question`;
}

function buildTaskRunnerPrompt(task, agentName, agentId) {
  const taskDetails = `[Task][task-runner-${agentName}][AGENT:${agentId}] You are an orchestrator processing a TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}`;

  const completionBlock = `## When Done

You MUST call this MCP tool to mark the task as completed:

\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`

## Constraints

- Focus only on this specific task
- Do not create new tasks unless absolutely necessary
- Report any issues via mcp__agent-reports__report_to_deputy_cto`;

  // Section-specific workflow instructions
  if (task.section === 'CODE-REVIEWER') {
    return `${taskDetails}

## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

1. \`Task(subagent_type='investigator')\` - Research the task, understand the codebase
2. \`Task(subagent_type='code-writer')\` - Implement the changes
3. \`Task(subagent_type='test-writer')\` - Add/update tests
4. \`Task(subagent_type='code-reviewer')\` - Review changes, commit
5. \`Task(subagent_type='project-manager')\` - Sync documentation (ALWAYS LAST)

Pass the full task context to each sub-agent. Each sub-agent has specialized
instructions loaded from .claude/agents/ configs.

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making code changes without the code-writer sub-agent
- Making test changes without the test-writer sub-agent
- Skipping investigation before implementation
- Skipping code-reviewer after any code/test changes
- Skipping project-manager at the end

${completionBlock}`;
  }

  if (task.section === 'INVESTIGATOR & PLANNER') {
    return `${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='investigator', prompt='${task.title}. ${task.description || ''}')
\`\`\`

The investigator sub-agent has specialized instructions loaded from .claude/agents/investigator.md.
Pass the full task context including title and description.

${completionBlock}`;
  }

  if (task.section === 'TEST-WRITER') {
    return `${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='test-writer', prompt='${task.title}. ${task.description || ''}')
\`\`\`

Then after test-writer completes:
\`\`\`
Task(subagent_type='code-reviewer', prompt='Review the test changes from the previous step')
\`\`\`

Each sub-agent has specialized instructions loaded from .claude/agents/ configs.

${completionBlock}`;
  }

  if (task.section === 'PROJECT-MANAGER') {
    return `${taskDetails}

## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='project-manager', prompt='${task.title}. ${task.description || ''}')
\`\`\`

The project-manager sub-agent has specialized instructions loaded from .claude/agents/project-manager.md.
Pass the full task context including title and description.

${completionBlock}`;
  }

  // Fallback for any other section
  return `${taskDetails}

## Your Role

You are the \`${agentName}\` agent. Complete the task described above using your expertise.
Use the Task tool to spawn the appropriate sub-agent: \`Task(subagent_type='${agentName}')\`

${completionBlock}`;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  if (config.sections.length === 0) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [],
      errors: [{ message: 'No sections specified. Use --sections "SECTION1,SECTION2"' }],
    }));
    process.exit(1);
  }

  // Validate sections against the static key map (before AGENT_TYPES is loaded)
  const invalidSections = config.sections.filter(s => !SECTION_AGENT_MAP_KEYS[s]);
  if (invalidSections.length > 0) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [],
      errors: [{ message: `Invalid sections: ${invalidSections.join(', ')}. Valid: ${Object.keys(SECTION_AGENT_MAP_KEYS).join(', ')}` }],
    }));
    process.exit(1);
  }

  // Load dependencies
  await loadDatabase();
  await loadAgentTracker(config.projectDir);

  // Resolve SECTION_AGENT_MAP now that AGENT_TYPES is available
  resolveSectionAgentMap();

  if (!Database) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [],
      errors: [{ message: 'better-sqlite3 not available — cannot query todo.db' }],
    }));
    process.exit(1);
  }

  const todoDbPath = path.join(config.projectDir, '.claude', 'todo.db');
  if (!fs.existsSync(todoDbPath)) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [],
      errors: [{ message: `todo.db not found at ${todoDbPath}` }],
    }));
    process.exit(1);
  }

  // Query ALL pending tasks in requested sections — NO age filter, NO batch limit
  let candidates;
  try {
    const db = new Database(todoDbPath, { readonly: true });
    const placeholders = config.sections.map(() => '?').join(',');
    candidates = db.prepare(`
      SELECT id, section, title, description, priority
      FROM tasks
      WHERE status = 'pending'
        AND section IN (${placeholders})
      ORDER BY
        CASE WHEN priority = 'urgent' THEN 0 ELSE 1 END,
        created_timestamp ASC
    `).all(...config.sections);
    db.close();
  } catch (err) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [],
      errors: [{ message: `DB query error: ${err.message}` }],
    }));
    process.exit(1);
  }

  if (candidates.length === 0) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [{ reason: 'No pending tasks found in requested sections' }],
      errors: [],
    }));
    process.exit(0);
  }

  // Reap completed agents before counting to free slots
  try {
    const { reapCompletedAgents } = await import('./reap-completed-agents.js');
    const reapResult = reapCompletedAgents(config.projectDir);
    if (reapResult.reaped.length > 0) {
      // Log reaped agents in result metadata (visible in JSON output)
    }
  } catch {
    // Non-fatal — count will be conservative
  }

  // Check running agents, calculate available slots
  const runningAgents = countRunningAgents();
  const availableSlots = Math.max(0, config.maxConcurrent - runningAgents);

  const spawned = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < candidates.length; i++) {
    const task = candidates[i];
    const mapping = SECTION_AGENT_MAP[task.section];

    if (i >= availableSlots) {
      skipped.push({
        taskId: task.id,
        title: task.title,
        section: task.section,
        reason: `Concurrency limit reached (${runningAgents + availableSlots}/${config.maxConcurrent})`,
      });
      continue;
    }

    // Mark in_progress before spawning
    if (!markTaskInProgress(task.id, todoDbPath)) {
      errors.push({
        taskId: task.id,
        title: task.title,
        message: 'Failed to mark task in_progress',
      });
      continue;
    }

    // Register with agent tracker first (to get agentId for prompt embedding)
    const agentId = registerSpawn({
      type: mapping.agentType,
      hookType: HOOK_TYPES.TASK_RUNNER,
      description: `Force-spawn: ${mapping.agent} - ${task.title}`,
      prompt: '',  // Will be set after prompt is built
      metadata: { taskId: task.id, section: task.section, source: 'force-spawn-tasks' },
    });

    // Build prompt with embedded agent ID for reaper tracking
    const prompt = mapping.agent === 'deputy-cto'
      ? buildDeputyCtoTaskPrompt(task, agentId)
      : buildTaskRunnerPrompt(task, mapping.agent, agentId);

    // Store the prompt now that it's built
    if (updateAgent) {
      updateAgent(agentId, { prompt });
    }

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

      // Store PID for reaper tracking
      if (updateAgent) {
        updateAgent(agentId, { pid: claude.pid, status: 'running' });
      }

      spawned.push({
        taskId: task.id,
        title: task.title,
        section: task.section,
        agent: mapping.agent,
        agentId: agentId,
        pid: claude.pid,
      });
    } catch (err) {
      resetTaskToPending(task.id, todoDbPath);
      errors.push({
        taskId: task.id,
        title: task.title,
        message: `Spawn failed: ${err.message}`,
      });
    }
  }

  console.log(JSON.stringify({ spawned, skipped, errors }));
}

main().catch((err) => {
  console.log(JSON.stringify({
    spawned: [],
    skipped: [],
    errors: [{ message: `Fatal error: ${err.message}` }],
  }));
  process.exit(1);
});
