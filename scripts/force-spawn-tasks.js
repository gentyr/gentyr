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
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    sections: [],
    taskIds: [],
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    maxConcurrent: 10,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sections' && args[i + 1]) {
      result.sections = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (args[i] === '--task-ids' && args[i + 1]) {
      result.taskIds = args[++i].split(',').map(s => s.trim()).filter(Boolean);
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
// AGENT TRACKER + SESSION QUEUE IMPORT
// ---------------------------------------------------------------------------

// Resolve the agent-tracker and session-queue relative to the project's .claude/hooks/
let AGENT_TYPES, HOOK_TYPES;
let enqueueSession;

async function loadAgentTracker(projectDir) {
  const trackerPath = path.join(projectDir, '.claude', 'hooks', 'agent-tracker.js');
  if (!fs.existsSync(trackerPath)) {
    // Fallback: try framework-relative path
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
// WORKTREE IMPORTS
// ---------------------------------------------------------------------------

let createWorktree, getFeatureBranchName;

async function loadWorktreeHelpers(projectDir) {
  const worktreePath = path.join(projectDir, '.claude', 'hooks', 'lib', 'worktree-manager.js');
  const branchPath = path.join(projectDir, '.claude', 'hooks', 'lib', 'feature-branch-helper.js');

  if (!fs.existsSync(worktreePath) || !fs.existsSync(branchPath)) {
    // Fallback: try framework-relative path
    const fwWorktree = path.resolve(__dirname, '..', '.claude', 'hooks', 'lib', 'worktree-manager.js');
    const fwBranch = path.resolve(__dirname, '..', '.claude', 'hooks', 'lib', 'feature-branch-helper.js');
    if (fs.existsSync(fwWorktree) && fs.existsSync(fwBranch)) {
      createWorktree = (await import(fwWorktree)).createWorktree;
      getFeatureBranchName = (await import(fwBranch)).getFeatureBranchName;
      return;
    }
    // Non-fatal: worktree creation will be skipped
    return;
  }
  createWorktree = (await import(worktreePath)).createWorktree;
  getFeatureBranchName = (await import(branchPath)).getFeatureBranchName;
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
  'DEMO-MANAGER': { agent: 'demo-manager', agentTypeKey: 'TASK_RUNNER_DEMO_MANAGER' },
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
      "pgrep -f 'claude.*--dangerously-skip-permissions' 2>/dev/null | wc -l",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    // pgrep returns exit code 1 when no processes match
    return 0;
  }
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
    const now = new Date();
    const started_at = now.toISOString();
    const started_timestamp = Math.floor(now.getTime() / 1000);
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', started_at = ?, started_timestamp = ? WHERE id = ?"
    ).run(started_at, started_timestamp, taskId);
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
      "UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?"
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
  return `[Automation][task-runner-deputy-cto][AGENT:${agentId}] You are the Deputy-CTO processing a high-level task assignment.

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

### Step 4: Summarize and Complete
After all sub-tasks are created:
\`\`\`
mcp__todo-db__summarize_work({ summary: "<what you triaged, how many sub-tasks created, key decisions>", success: true/false })
\`\`\`
Then:
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
This will automatically create a follow-up verification task.

## Constraints

- Do NOT write code yourself (you have no Edit/Write/Bash tools)
- Create the minimum sub-tasks needed (prefer 1-3 focused tasks over exhaustive decomposition)
- Each sub-task must be self-contained with enough context to execute independently
- Only delegate tasks that align with project specs and plans
- Report blockers via mcp__agent-reports__report_to_deputy_cto
- If the task needs CTO input, create a question via mcp__deputy-cto__add_question`;
}

function buildTaskRunnerPrompt(task, agentName, agentId, worktreePath = null) {
  const taskDetails = `[Automation][task-runner-${agentName}][AGENT:${agentId}] You are an orchestrator processing a TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}`;

  // Working directory note for worktree-based agents
  const worktreeNote = worktreePath ? `
## Working Directory

You are in a git worktree at: ${worktreePath}
All git operations (commit, push, PR, merge) are handled by the project-manager sub-agent.
You MUST NOT run git add, git commit, git push, or gh pr create yourself.
` : '';

  const completionBlock = `## When Done

### Step 1: Summarize Your Work (MANDATORY)
\`\`\`
mcp__todo-db__summarize_work({ summary: "<concise description of what you did and the outcome>", success: true/false })
\`\`\`
task_id is auto-resolved from your CLAUDE_AGENT_ID — do not pass it manually.

### Step 2: Mark Task Complete
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
${worktreeNote}
## Constraints

- Focus only on this specific task
- Do NOT create new tasks. Report findings in your summarize_work summary instead
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
5. \`Task(subagent_type='project-manager')\` - Commit, push, and merge (ALWAYS LAST)

Pass the full task context to each sub-agent. Each sub-agent has specialized
instructions loaded from .claude/agents/ configs.

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making code changes without the code-writer sub-agent
- Making test changes without the test-writer sub-agent
- Skipping investigation before implementation
- Skipping code-reviewer after any code/test changes
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself

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

## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

1. \`Task(subagent_type='test-writer')\` - Write/update tests
2. \`Task(subagent_type='code-reviewer')\` - Review the test changes
3. \`Task(subagent_type='project-manager')\` - Commit, push, and merge (ALWAYS LAST)

Pass the full task context to each sub-agent. Each sub-agent has specialized
instructions loaded from .claude/agents/ configs.

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making test changes without the test-writer sub-agent
- Skipping code-reviewer after test changes
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself

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

  if (task.section === 'DEMO-MANAGER') {
    return `${taskDetails}

## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR for demo lifecycle work. Follow this sequence using the Task tool:

1. \`Task(subagent_type='investigator')\` - Investigate the issue (read .demo.ts, check selectors, review error)
2. \`Task(subagent_type='demo-manager', isolation='worktree')\` - Plan and implement .demo.ts fixes, register prerequisites/scenarios
3. \`Task(subagent_type='code-reviewer')\` - Review changes
4. \`Task(subagent_type='project-manager')\` - Commit, push, merge, cleanup worktree (ALWAYS LAST)

If the issue is in APPLICATION CODE (not demo code):
- Escalate via mcp__agent-reports__report_to_deputy_cto
- Do NOT attempt app code fixes

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Modifying application source code
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself

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

  if (config.sections.length === 0 && config.taskIds.length === 0) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [],
      errors: [{ message: 'No sections or task IDs specified. Use --sections or --task-ids' }],
    }));
    process.exit(1);
  }

  // Validate sections only when using section-based mode
  if (config.sections.length > 0) {
    const invalidSections = config.sections.filter(s => !SECTION_AGENT_MAP_KEYS[s]);
    if (invalidSections.length > 0) {
      console.log(JSON.stringify({
        spawned: [],
        skipped: [],
        errors: [{ message: `Invalid sections: ${invalidSections.join(', ')}. Valid: ${Object.keys(SECTION_AGENT_MAP_KEYS).join(', ')}` }],
      }));
      process.exit(1);
    }
  }

  // Load dependencies
  await loadDatabase();
  await loadAgentTracker(config.projectDir);
  await loadSessionQueue(config.projectDir);
  await loadWorktreeHelpers(config.projectDir);

  // Resolve SECTION_AGENT_MAP now that AGENT_TYPES is available
  resolveSectionAgentMap();

  let debugLogFn = () => {};
  try {
    const mod = await import(path.join(config.projectDir, '.claude', 'hooks', 'lib', 'debug-log.js'));
    debugLogFn = mod.debugLog;
  } catch (_) { /* debug-log not available */ }

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

  // Query ALL pending tasks — NO age filter, NO batch limit
  let candidates;
  try {
    const db = new Database(todoDbPath, { readonly: true });

    if (config.taskIds.length > 0) {
      // Task ID mode: query specific tasks by ID.
      // Include in_progress tasks that may be orphaned (no running agent).
      const placeholders = config.taskIds.map(() => '?').join(',');
      candidates = db.prepare(`
        SELECT id, section, title, description, priority, status
        FROM tasks
        WHERE status IN ('pending', 'in_progress')
          AND id IN (${placeholders})
        ORDER BY
          CASE WHEN priority = 'urgent' THEN 0 ELSE 1 END,
          created_timestamp ASC
      `).all(...config.taskIds);
    } else {
      // Section mode: only pending tasks (in_progress are assumed to have agents)
      const placeholders = config.sections.map(() => '?').join(',');
      candidates = db.prepare(`
        SELECT id, section, title, description, priority, status
        FROM tasks
        WHERE status = 'pending'
          AND section IN (${placeholders})
        ORDER BY
          CASE WHEN priority = 'urgent' THEN 0 ELSE 1 END,
          created_timestamp ASC
      `).all(...config.sections);
    }
    db.close();
  } catch (err) {
    console.log(JSON.stringify({
      spawned: [],
      skipped: [],
      errors: [{ message: `DB query error: ${err.message}` }],
    }));
    process.exit(1);
  }

  debugLogFn('force-spawn', 'query', { candidateCount: candidates.length });

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

    if (!mapping) {
      skipped.push({
        taskId: task.id,
        title: task.title,
        section: task.section,
        reason: `Unknown section: ${task.section}. Valid: ${Object.keys(SECTION_AGENT_MAP_KEYS).join(', ')}`,
      });
      continue;
    }

    if (i >= availableSlots) {
      skipped.push({
        taskId: task.id,
        title: task.title,
        section: task.section,
        reason: `Concurrency limit reached (${runningAgents + availableSlots}/${config.maxConcurrent})`,
      });
      continue;
    }

    // For in_progress orphans, reset to pending first so markTaskInProgress succeeds
    if (task.status === 'in_progress') {
      try {
        const resetDb = new Database(todoDbPath);
        resetDb.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?").run(task.id);
        resetDb.close();
        debugLogFn('force-spawn', 'orphan_reset', { taskId: task.id });
      } catch {
        // Non-fatal — markTaskInProgress will fail and we'll skip
      }
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

    // --- Worktree setup (best-effort) ---
    let agentCwd = config.projectDir;
    let agentMcpConfig = path.join(config.projectDir, '.mcp.json');
    let worktreePath = null;

    if (createWorktree && getFeatureBranchName) {
      try {
        const branchName = getFeatureBranchName(task.title, task.id);
        // Phase 3: skipFetch for latency-critical spawning (user expects instant)
        const worktree = createWorktree(branchName, undefined, { skipFetch: true });
        worktreePath = worktree.path;
        agentCwd = worktree.path;
        agentMcpConfig = path.join(worktree.path, '.mcp.json');
      } catch (err) {
        // Non-fatal: fall back to project dir
        process.stderr.write(`[force-spawn] Worktree creation failed for task ${task.id}, using project dir: ${err.message}\n`);
      }
    }

    // Enqueue the session — the queue handles registerSpawn, buildSpawnEnv, and spawn internally.
    // Use buildPrompt as a deferred builder so the agentId is available when the prompt is constructed.
    try {
      const { queueId } = enqueueSession({
        title: `Force-spawn: ${mapping.agent} - ${task.title}`,
        agentType: mapping.agentType,
        hookType: HOOK_TYPES.TASK_RUNNER,
        tagContext: `task-runner-${mapping.agent}`,
        source: 'force-spawn-tasks',
        buildPrompt: (agentId) => mapping.agent === 'deputy-cto'
          ? buildDeputyCtoTaskPrompt(task, agentId)
          : buildTaskRunnerPrompt(task, mapping.agent, agentId, worktreePath),
        cwd: agentCwd,
        mcpConfig: agentMcpConfig,
        worktreePath: worktreePath || null,
        projectDir: config.projectDir,
        priority: task.priority === 'urgent' ? 'urgent' : 'normal',
        metadata: { taskId: task.id, section: task.section, worktreePath, source: 'force-spawn-tasks' },
        ttlMs: 30 * 60 * 1000,
      });

      debugLogFn('force-spawn', 'spawned', { taskId: task.id, queueId });

      spawned.push({
        taskId: task.id,
        title: task.title,
        section: task.section,
        agent: mapping.agent,
        queueId,
        worktreePath,
      });
    } catch (err) {
      resetTaskToPending(task.id, todoDbPath);
      errors.push({
        taskId: task.id,
        title: task.title,
        message: `Enqueue failed: ${err.message}`,
      });
    }
  }

  debugLogFn('force-spawn', 'complete', { spawned: spawned.length, skipped: skipped.length, errors: errors.length });

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
