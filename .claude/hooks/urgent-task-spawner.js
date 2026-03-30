#!/usr/bin/env node
/**
 * PostToolUse Hook: Universal Task Spawner
 *
 * Fires after mcp__todo-db__create_task. Uses quota-based gating to decide
 * whether to spawn an agent immediately:
 *
 *   - Urgent tasks: always spawn (backward compatible)
 *   - Normal tasks with < 75% quota: spawn immediately
 *   - Normal tasks with 75-90% quota: spawn if < 3 running agents
 *   - Normal tasks with > 90% quota: only urgent tasks
 *
 * Deduplication strategy:
 *   1. markTaskInProgress() as atomic gate — hourly dispatcher skips in_progress tasks
 *   2. Status-based exclusion — hourly naturally skips tasks already started
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 * All errors go to stderr for verbose mode debugging.
 *
 * @version 2.0.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { createWorktree } from './lib/worktree-manager.js';
import { getFeatureBranchName } from './lib/feature-branch-helper.js';
import { readRotationState } from './key-sync.js';
import { shouldAllowSpawn } from './lib/memory-pressure.js';
import { resolveUserPrompts } from './lib/user-prompt-resolver.js';
import { enqueueSession, preemptForCtoTask } from './lib/session-queue.js';
import { debugLog } from './lib/debug-log.js';
import { buildBridgeMainTreePrompt } from './lib/bridge-main-tree-prompt.js';

// Try to import better-sqlite3 for DB access
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[urgent-task-spawner] Warning:', err.message);
  // Non-fatal: hook will skip if unavailable
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'urgent-task-spawner.log');

// No concurrency limit for urgent tasks — if 100 urgent tasks are created,
// 100 sessions spawn. The hourly automation has its own limit for normal tasks.

// Section-to-agent mapping: mirrors hourly-automation.js (lines 56-63)
const SECTION_AGENT_MAP = {
  'CODE-REVIEWER': { agent: 'code-reviewer', agentType: AGENT_TYPES.TASK_RUNNER_CODE_REVIEWER },
  'INVESTIGATOR & PLANNER': { agent: 'investigator', agentType: AGENT_TYPES.TASK_RUNNER_INVESTIGATOR },
  'TEST-WRITER': { agent: 'test-writer', agentType: AGENT_TYPES.TASK_RUNNER_TEST_WRITER },
  'PROJECT-MANAGER': { agent: 'project-manager', agentType: AGENT_TYPES.TASK_RUNNER_PROJECT_MANAGER },
  'DEPUTY-CTO': { agent: 'deputy-cto', agentType: AGENT_TYPES.TASK_RUNNER_DEPUTY_CTO },
  'PRODUCT-MANAGER': { agent: 'product-manager', agentType: AGENT_TYPES.TASK_RUNNER_PRODUCT_MANAGER },
  'DEMO-MANAGER': { agent: 'demo-manager', agentType: AGENT_TYPES.TASK_RUNNER_DEMO_MANAGER },
};

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [urgent-task-spawner] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('[urgent-task-spawner] Warning:', err.message);
    // Non-fatal
  }
}

// ============================================================================
// Helpers (inlined from hourly-automation.js for self-containment)
// ============================================================================

/**
 * Mark a task as in_progress before spawning (mirrors hourly-automation.js:1252-1267)
 */
function markTaskInProgress(taskId) {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) return false;

  try {
    const db = new Database(TODO_DB_PATH);
    const now = new Date();
    const started_at = now.toISOString();
    const started_timestamp = Math.floor(now.getTime() / 1000);
    const result = db.prepare(
      "UPDATE tasks SET status = 'in_progress', started_at = ?, started_timestamp = ? WHERE id = ? AND status = 'pending'"
    ).run(started_at, started_timestamp, taskId);
    db.close();
    return result.changes > 0;
  } catch (err) {
    log(`Failed to mark task ${taskId} in_progress: ${err.message}`);
    return false;
  }
}

/**
 * Reset a task back to pending on spawn failure (mirrors hourly-automation.js:1272-1284)
 */
function resetTaskToPending(taskId) {
  if (!Database || !fs.existsSync(TODO_DB_PATH)) return;

  try {
    const db = new Database(TODO_DB_PATH);
    db.prepare(
      "UPDATE tasks SET status = 'pending', started_at = NULL, started_timestamp = NULL WHERE id = ?"
    ).run(taskId);
    db.close();
  } catch (err) {
    log(`Failed to reset task ${taskId}: ${err.message}`);
  }
}

/**
 * Phase 2: Quota-based gating for task spawning.
 *
 * Reads aggregate quota usage across all valid keys and determines whether
 * to spawn based on current load:
 *   - < 75%: spawn immediately, no limit
 *   - 75-90%: spawn only if < 3 running agents (fast check via history file)
 *   - > 90%: only urgent tasks (backward compatible)
 *
 * Fails open on errors (returns true).
 *
 * @param {string} priority - Task priority ('urgent' or 'normal')
 * @returns {boolean} Whether to proceed with spawning
 */
function evaluateQuotaGating(priority) {
  // Memory pressure check — runs before quota check, blocks even urgent tasks if critical
  const memCheck = shouldAllowSpawn({ priority, context: 'task-spawner' });
  if (!memCheck.allowed) {
    log(memCheck.reason);
    return false;
  }
  if (memCheck.reason) log(memCheck.reason);

  // Urgent tasks always spawn (memory check already passed)
  if (priority === 'urgent') return true;

  try {
    const state = readRotationState();
    if (!state.keys || Object.keys(state.keys).length === 0) return true;

    // Calculate best (lowest) max usage across all valid keys
    let bestMaxUsage = 100;
    for (const [, keyData] of Object.entries(state.keys)) {
      if (keyData.status === 'invalid' || keyData.status === 'tombstone' || keyData.status === 'merged') continue;
      const usage = keyData.last_usage;
      if (!usage) continue;
      const maxUsage = Math.max(usage.five_hour || 0, usage.seven_day || 0, usage.seven_day_sonnet || 0);
      if (maxUsage < bestMaxUsage) bestMaxUsage = maxUsage;
    }

    if (bestMaxUsage < 75) {
      // Green zone: spawn freely
      log(`Quota gating: green zone (${Math.round(bestMaxUsage)}% best key), spawning`);
      return true;
    }

    if (bestMaxUsage < 90) {
      // Yellow zone: spawn if < 3 running agents (quick file-based check, no pgrep fork)
      let runningCount = 0;
      try {
        const historyPath = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
        if (fs.existsSync(historyPath)) {
          const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
          if (Array.isArray(history.agents)) {
            runningCount = history.agents.filter(a => a.status === 'running').length;
          }
        }
      } catch (err) {
        console.error('[urgent-task-spawner] Warning:', err.message);
        /* fail open */
      }

      if (runningCount < 3) {
        log(`Quota gating: yellow zone (${Math.round(bestMaxUsage)}%, ${runningCount} running), spawning`);
        return true;
      }
      log(`Quota gating: yellow zone (${Math.round(bestMaxUsage)}%, ${runningCount} running), deferring to hourly`);
      return false;
    }

    // Red zone: only urgent
    log(`Quota gating: red zone (${Math.round(bestMaxUsage)}%), deferring normal task to hourly`);
    return false;
  } catch (err) {
    // Fail open
    log(`Quota gating error (fail open): ${err.message}`);
    return true;
  }
}

/**
 * Build prompt for deputy-cto tasks (mirrors hourly-automation.js:1289-1369)
 */
function buildDeputyCtoTaskPrompt(task, agentId) {
  const isCtoTask = task.assigned_by === 'cto' || task.assigned_by === 'human';
  return `[Automation][task-runner-deputy-cto][AGENT:${agentId}] You are the Deputy-CTO processing a high-level task assignment.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
- **Priority**: ${isCtoTask ? 'CTO (immediate)' : 'Normal'} (spawned by urgent-task-spawner hook)
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
Always start by creating an investigator task:
\`\`\`
mcp__todo-db__create_task({
  section: "INVESTIGATOR & PLANNER",
  title: "Investigate: ${task.title}",
  description: "You are the INVESTIGATOR. Analyze the following task and create a detailed implementation plan with specific sub-tasks:\\n\\nTask: ${task.title}\\n${task.description || ''}\\n\\nInvestigate the codebase, read relevant specs, and create TODO items in the appropriate sections via mcp__todo-db__create_task for each sub-task you identify.",
  assigned_by: "deputy-cto",
  priority: "normal"
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

- Do NOT write code yourself (you have no Edit/Write tools)
- Create the minimum sub-tasks needed (prefer 1-3 focused tasks over exhaustive decomposition)
- Each sub-task must be self-contained with enough context to execute independently
- Only delegate tasks that align with project specs and plans
- Report blockers via mcp__agent-reports__report_to_deputy_cto
- If the task needs CTO input, create a question via mcp__deputy-cto__add_question`;
}

/**
 * Build prompt for standard task runner (simplified from hourly-automation.js:1371-1516)
 */
function buildTaskRunnerPrompt(task, agentName, agentId, worktreePath = null) {
  const isCtoTask = task.assigned_by === 'cto' || task.assigned_by === 'human';
  const taskDetails = `[Automation][task-runner-${agentName}][AGENT:${agentId}] You are an orchestrator processing a TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
- **Priority**: ${isCtoTask ? 'CTO (immediate)' : 'Normal'} (spawned by urgent-task-spawner hook)
${task.description ? `- **Description**: ${task.description}` : ''}`;

  const worktreeNote = worktreePath ? `
## Working Directory

You are in a git worktree at: ${worktreePath}
All git operations (commit, push, PR, merge, worktree cleanup) are handled by the project-manager sub-agent.
You MUST NOT run git add, git commit, git push, or gh pr create yourself.
CRITICAL: You MUST spawn the project-manager before completing your task. The project-manager
is responsible for merging your work AND removing this worktree. If you skip it, the worktree
will be orphaned and your changes will not be merged.
` : '';

  const errorHandlingBlock = `## Error Handling — DIAGNOSE BEFORE GIVING UP

When a tool call or sub-agent fails:

1. **Read the error message** — understand what actually failed
2. **Diagnose** — is this transient (retry), a missing dependency (fix), or a systemic blocker (escalate)?
3. **Attempt recovery** — try at least ONE alternative approach before declaring blocked:
   - Secret resolution failed → check dev server: \`mcp__secret-sync__secret_dev_server_status\`, start if needed
   - Build failed → read the error output, fix the code, rebuild
   - Demo failed → read \`check_demo_result\`, inspect screenshots/frames, fix and re-run
   - Tool timeout → retry once with a longer timeout
4. **Only escalate if recovery fails** — report via \`mcp__agent-reports__report_to_deputy_cto\` with what failed, what you tried, and why it's unrecoverable

Do NOT immediately call summarize_work(success: false) on the first failure. Iterate.
`;

  const completionBlock = `${errorHandlingBlock}
## When Done

### Step 1: Run project-manager (MANDATORY for code/test changes)
If you made ANY file changes (code, tests, config), you MUST spawn the project-manager sub-agent
BEFORE completing the task. The project-manager commits, pushes, creates a PR, self-merges,
and removes the worktree. Skipping this step leaves orphaned worktrees and unmerged code.
\`\`\`
Task(subagent_type='project-manager', prompt='Commit all changes, push, create PR, self-merge, and clean up the worktree.')
\`\`\`
If no file changes were made (investigation/research only), skip to Step 2.

### Step 2: Summarize Your Work (MANDATORY)
\`\`\`
mcp__todo-db__summarize_work({ summary: "<concise description of what you did and the outcome>", success: true/false })
\`\`\`
task_id is auto-resolved from your CLAUDE_AGENT_ID — do not pass it manually.

### Step 3: Mark Task Complete
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
${worktreeNote}
## Constraints

- Focus only on this specific task
- Do NOT create new tasks. Report findings in your summarize_work summary instead
- Report any issues via mcp__agent-reports__report_to_deputy_cto`;

  // Section-specific immediate actions
  const sectionActions = {
    'CODE-REVIEWER': `
## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

1. \`Task(subagent_type='investigator')\` - Research the task
2. \`Task(subagent_type='code-writer')\` - Implement the changes
3. \`Task(subagent_type='test-writer')\` - Add/update tests
4. \`Task(subagent_type='code-reviewer')\` - Review changes, commit
5. \`Task(subagent_type='user-alignment')\` - Verify implementation honors user intent
6. \`Task(subagent_type='project-manager')\` - Commit, push, and merge (ALWAYS LAST)

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making code changes without the code-writer sub-agent
- Making test changes without the test-writer sub-agent
- Skipping investigation before implementation
- Skipping code-reviewer after any code/test changes
- Skipping user-alignment after code-reviewer
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself

**WORKFLOW DEFAULTS:**
This 6-step sequence is the standard development workflow and the DEFAULT for all code change tasks. However, if the task description provides EXPLICIT alternative workflow instructions (e.g., "skip investigation, just build and run the demo" or "only run the test suite"), follow those instructions instead. The task creator knows the context — trust their instructions over the default pipeline. The only invariant is: if you made file changes, you MUST spawn project-manager before completing.`,

    'INVESTIGATOR & PLANNER': `
## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='investigator', prompt='${task.title}. ${task.description || ''}')
\`\`\``,

    'TEST-WRITER': `
## MANDATORY SUB-AGENT WORKFLOW

You are an ORCHESTRATOR. Do NOT edit files directly. Follow this sequence using the Task tool:

1. \`Task(subagent_type='test-writer')\` - Write/update tests
2. \`Task(subagent_type='code-reviewer')\` - Review the test changes
3. \`Task(subagent_type='project-manager')\` - Commit, push, and merge (ALWAYS LAST)

Pass the full task context to each sub-agent.

**YOU ARE PROHIBITED FROM:**
- Directly editing ANY files using Edit, Write, or NotebookEdit tools
- Making test changes without the test-writer sub-agent
- Skipping code-reviewer after test changes
- Skipping project-manager at the end
- Running git add, git commit, git push, or gh pr create yourself`,

    'PROJECT-MANAGER': `
## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='project-manager', prompt='${task.title}. ${task.description || ''}')
\`\`\``,

    'DEMO-MANAGER': `
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
- Running git add, git commit, git push, or gh pr create yourself`,
  };

  const action = sectionActions[task.section] || `
## Your Role

You are the \`${agentName}\` agent. Complete the task described above using your expertise.
Use the Task tool to spawn the appropriate sub-agent: \`Task(subagent_type='${agentName}')\``;

  // Resolve user prompt references if available
  let userPromptBlock = '';
  if (task.user_prompt_uuids) {
    try {
      const uuids = typeof task.user_prompt_uuids === 'string'
        ? JSON.parse(task.user_prompt_uuids)
        : task.user_prompt_uuids;
      if (Array.isArray(uuids) && uuids.length > 0) {
        const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        userPromptBlock = resolveUserPrompts(uuids, PROJECT_DIR);
      }
    } catch (err) {
      console.error('[urgent-task-spawner] Warning: user prompt resolution failed:', err.message);
    }
  }

  // Bridge mode: inject MCP-first infrastructure instructions when bridge_main_tree is set
  const bridgeSection = (task.bridge_main_tree && worktreePath)
    ? buildBridgeMainTreePrompt(worktreePath, !!task.demo_involved)
    : '';

  return `${taskDetails}\n${userPromptBlock}\n${action}\n\n${completionBlock}${bridgeSection}`;
}

/**
 * Enqueue a fire-and-forget Claude agent for a task.
 * Mirrors hourly-automation.js:1524-1587 but simplified for single-task use.
 *
 * @param {object} task - Task object with id, section, title, description, assigned_by
 * @returns {Promise<boolean>} Whether the task was successfully enqueued
 */
async function spawnTaskAgent(task) {
  const mapping = SECTION_AGENT_MAP[task.section];
  if (!mapping) return false;

  // Determine if this is a CTO-directed task — use highest priority
  const isCtoTask = task.assigned_by === 'cto' || task.assigned_by === 'human';
  const queuePriority = isCtoTask ? 'cto' : 'normal';

  if (isCtoTask) {
    log(`CTO task detected (assigned_by: ${task.assigned_by}) — using cto priority for task ${task.id}`);
  }

  // Worktree setup (best-effort)
  let worktreePath = null;

  try {
    const branchName = getFeatureBranchName(task.title, task.id);
    // Phase 2: skipFetch for latency-critical spawning (drops 3-8s to <1s)
    const worktree = createWorktree(branchName, undefined, { skipFetch: true });
    worktreePath = worktree.path;
    log(`Worktree ready at ${worktree.path} (branch ${branchName})`);
  } catch (err) {
    log(`Worktree creation failed, falling back to PROJECT_DIR: ${err.message}`);
  }

  try {
    const result = enqueueSession({
      title: `${isCtoTask ? 'CTO task' : 'Task'}: ${mapping.agent} - ${task.title}`,
      agentType: mapping.agentType,
      hookType: HOOK_TYPES.TASK_RUNNER,
      tagContext: `task-runner-${mapping.agent}`,
      source: 'urgent-task-spawner',
      buildPrompt: (agentId) => mapping.agent === 'deputy-cto'
        ? buildDeputyCtoTaskPrompt(task, agentId)
        : buildTaskRunnerPrompt(task, mapping.agent, agentId, worktreePath),
      priority: queuePriority,
      cwd: worktreePath || PROJECT_DIR,
      mcpConfig: path.join(worktreePath || PROJECT_DIR, '.mcp.json'),
      projectDir: PROJECT_DIR,
      worktreePath: worktreePath || null,
      extraEnv: {
        ...(task.bridge_main_tree ? { GENTYR_BRIDGE_MAIN_TREE: 'true' } : {}),
      },
      metadata: { taskId: task.id, section: task.section, worktreePath, urgent: true, assignedBy: task.assigned_by },
    });

    const spawnedImmediately = result.drained && result.drained.spawned > 0;
    log(`Enqueued ${mapping.agent} for task ${task.id}: "${task.title}" (priority: ${queuePriority}, queueId: ${result.queueId}, spawned: ${spawnedImmediately})`);

    // For CTO tasks: if the queue was at capacity (nothing was spawned immediately),
    // trigger preemption of the lowest-priority running session to make room.
    if (isCtoTask && result.drained.spawned === 0 && result.drained.atCapacity) {
      log(`CTO task ${task.id} is at capacity — triggering preemption`);
      try {
        const preemptResult = await preemptForCtoTask(result.queueId, PROJECT_DIR);
        if (preemptResult.preempted) {
          log(`Preempted session ${preemptResult.preemptedQueueId} (agent: ${preemptResult.preemptedAgentId}) for CTO task ${task.id}`);
        } else {
          log(`Preemption not needed for CTO task ${task.id} (capacity available after drain)`);
        }
      } catch (err) {
        log(`Preemption failed for CTO task ${task.id}: ${err.message}`);
        // Non-fatal — CTO task is still queued and will be picked up at next opportunity
      }
    }

    // Phase 2: Background fetch after enqueue — non-blocking, ensures worktree
    // has fresh base branch for subsequent operations
    if (worktreePath) {
      try {
        const fetchProc = spawn('git', ['fetch', 'origin', '--quiet'], {
          cwd: worktreePath,
          stdio: 'ignore',
          detached: true,
        });
        fetchProc.unref();
      } catch (err) {
        console.error('[urgent-task-spawner] Warning:', err.message);
        /* non-fatal */
      }
    }

    // Return 'queued' if enqueued but not spawned (memory pressure / capacity),
    // so the caller can reset the task to pending for retry.
    return spawnedImmediately ? true : 'queued';
  } catch (err) {
    log(`Failed to enqueue ${mapping.agent} for task ${task.id}: ${err.message}`);
    return false;
  }
}

// ============================================================================
// Main: Read PostToolUse stdin and process
// ============================================================================

let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString();
});

process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);
    const toolInput = hookInput.tool_input || {};

    // Phase 2: Quota-based gating replaces the old urgent-only guard.
    // CTO/human tasks bypass quota gating entirely — they always spawn.
    const assignedBy = toolInput.assigned_by || null;
    const isCtoOrHuman = assignedBy === 'cto' || assignedBy === 'human';
    const shouldSpawn = isCtoOrHuman || evaluateQuotaGating(toolInput.priority);
    debugLog('urgent-task-spawner', 'spawn_decision', { taskId: toolInput.title?.substring(0, 40), decision: shouldSpawn ? 'spawn' : 'defer', reason: isCtoOrHuman ? 'cto_or_human' : 'quota_gating', priority: toolInput.priority });
    if (!shouldSpawn) {
      process.exit(0);
    }

    // Extract task info from tool_input (available at PostToolUse time)
    const section = toolInput.section;
    const title = toolInput.title;
    const description = toolInput.description || null;

    // Parse the response to get the created task ID
    let taskId = null;
    try {
      const response = hookInput.tool_response;
      if (response && typeof response === 'object') {
        taskId = response.id;
      } else if (typeof response === 'string') {
        const parsed = JSON.parse(response);
        taskId = parsed.id;
      }
    } catch (err) {
      console.error('[urgent-task-spawner] Warning:', err.message);
      // Try extracting from content array (MCP tool response format)
      try {
        const response = hookInput.tool_response;
        if (response && response.content && Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'text' && block.text) {
              const parsed = JSON.parse(block.text);
              if (parsed.id) {
                taskId = parsed.id;
                break;
              }
            }
          }
        }
      } catch (err) {
        console.error('[urgent-task-spawner] Warning:', err.message);
        // Give up on parsing
      }
    }

    // Fallback: query database for the task we just created
    // The task was created milliseconds ago — match by section + title + pending status
    if (!taskId && Database && fs.existsSync(TODO_DB_PATH)) {
      try {
        const db = new Database(TODO_DB_PATH, { readonly: true });
        const row = db.prepare(
          "SELECT id FROM tasks WHERE section = ? AND title = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
        ).get(section, title);
        db.close();
        if (row && row.id) {
          taskId = row.id;
          log(`Resolved task ID via database fallback: ${taskId}`);
        }
      } catch (err) {
        log(`Database fallback failed: ${err.message}`);
      }
    }

    if (!taskId) {
      log(`Urgent task created but could not extract task ID from response. Section: ${section}, Title: ${title}`);
      process.exit(0);
    }

    debugLog('urgent-task-spawner', 'task_detected', { taskId, section, priority: toolInput.priority, title: title?.substring(0, 80) });

    if (!section || !SECTION_AGENT_MAP[section]) {
      log(`Urgent task ${taskId} has no agent mapping for section "${section}". Deferring to hourly.`);
      process.exit(0);
    }

    if (!Database) {
      log(`better-sqlite3 unavailable. Deferring urgent task ${taskId} to hourly.`);
      process.exit(0);
    }

    // Atomic gate: mark in_progress to prevent hourly from double-spawning
    if (!markTaskInProgress(taskId)) {
      log(`Task ${taskId} already started or not found. Skipping spawn.`);
      process.exit(0);
    }

    debugLog('urgent-task-spawner', 'task_marked_in_progress', { taskId });

    // Build task object for spawn (include assigned_by for CTO priority detection)
    const bridgeMainTree = toolInput.bridge_main_tree === true;
    const demoInvolved = toolInput.demo_involved === true;
    const task = { id: taskId, section, title, description, assigned_by: assignedBy, bridge_main_tree: bridgeMainTree, demo_involved: demoInvolved ? 1 : 0 };

    const spawnResult = await spawnTaskAgent(task);
    debugLog('urgent-task-spawner', 'spawn_result', { taskId, result: spawnResult === true ? 'spawned' : spawnResult === 'queued' ? 'queued' : 'failed' });
    if (spawnResult === true) {
      log(`Successfully spawned agent for urgent task ${taskId}: "${title}" (section: ${section})`);
    } else if (spawnResult === 'queued') {
      // Enqueued but not spawned (memory pressure or capacity). Reset to pending
      // so force_spawn_tasks and hourly automation can retry when pressure clears.
      resetTaskToPending(taskId);
      log(`Task ${taskId} enqueued but not spawned (memory/capacity). Reset to pending for retry.`);
    } else {
      resetTaskToPending(taskId);
      log(`Spawn failed for urgent task ${taskId}, reset to pending. Hourly will retry.`);
    }
  } catch (err) {
    process.stderr.write(`[urgent-task-spawner] Error: ${err.message}\n${err.stack}\n`);
  }

  // Always exit 0 — PostToolUse hooks must never block
  process.exit(0);
});
