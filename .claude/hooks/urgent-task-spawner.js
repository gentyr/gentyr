#!/usr/bin/env node
/**
 * PostToolUse Hook: Urgent Task Spawner
 *
 * Fires after mcp__todo-db__create_task. When priority is 'urgent', spawns
 * an agent immediately instead of waiting for the hourly automation cycle.
 *
 * Deduplication strategy:
 *   1. markTaskInProgress() as atomic gate — hourly dispatcher skips in_progress tasks
 *   2. Status-based exclusion — hourly naturally skips tasks already started
 *
 * No concurrency limit — urgent tasks always spawn immediately.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 * All errors go to stderr for verbose mode debugging.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { createWorktree } from './lib/worktree-manager.js';
import { getFeatureBranchName } from './lib/feature-branch-helper.js';
import { isProxyDisabled } from './lib/proxy-state.js';

// Try to import better-sqlite3 for DB access
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
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
};

const PROXY_PORT = process.env.GENTYR_PROXY_PORT || 18080;

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [urgent-task-spawner] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
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
    const now = new Date().toISOString();
    const result = db.prepare(
      "UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ? AND status = 'pending'"
    ).run(now, taskId);
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
      "UPDATE tasks SET status = 'pending', started_at = NULL WHERE id = ?"
    ).run(taskId);
    db.close();
  } catch (err) {
    log(`Failed to reset task ${taskId}: ${err.message}`);
  }
}

/**
 * Build the env object for spawning (mirrors hourly-automation.js:199-212)
 * Note: Does NOT resolve 1Password credentials (ensureCredentials).
 * The hook runs in the user's interactive session where env vars are already
 * available via process.env. Agent MCP servers that need 1Password credentials
 * inherit them from the env or use the proxy.
 */
function buildSpawnEnv(agentId) {
  // Resolve git-wrappers directory (follows symlinks for npm link model)
  const hooksDir = path.join(PROJECT_DIR, '.claude', 'hooks');
  let guardedPath = process.env.PATH || '/usr/bin:/bin';
  try {
    const realHooks = fs.realpathSync(hooksDir);
    const wrappersDir = path.join(realHooks, 'git-wrappers');
    if (fs.existsSync(path.join(wrappersDir, 'git'))) {
      guardedPath = `${wrappersDir}:${guardedPath}`;
    }
  } catch {}

  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: PROJECT_DIR,
    CLAUDE_SPAWNED_SESSION: 'true',
    CLAUDE_AGENT_ID: agentId,
    PATH: guardedPath,
  };

  if (!isProxyDisabled()) {
    env.HTTPS_PROXY = `http://localhost:${PROXY_PORT}`;
    env.HTTP_PROXY = `http://localhost:${PROXY_PORT}`;
    env.NO_PROXY = 'localhost,127.0.0.1';
    env.NODE_EXTRA_CA_CERTS = path.join(process.env.HOME || '/tmp', '.claude', 'proxy-certs', 'ca.pem');
  }

  return env;
}

/**
 * Build prompt for deputy-cto tasks (mirrors hourly-automation.js:1289-1369)
 */
function buildDeputyCtoTaskPrompt(task, agentId) {
  return `[Task][task-runner-deputy-cto][AGENT:${agentId}] You are the Deputy-CTO processing a high-level task assignment.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
${task.description ? `- **Description**: ${task.description}` : ''}

## Your Mission

Break down this high-level task and execute it using the appropriate sub-agents.
Use the Task tool to spawn specialized agents as needed:
- Task(subagent_type='investigator') for research
- Task(subagent_type='code-writer') for implementation
- Task(subagent_type='test-writer') for tests
- Task(subagent_type='code-reviewer') for review

## When Done

### Step 1: Summarize Your Work (MANDATORY)
\`\`\`
mcp__todo-db__summarize_work({ summary: "<concise description of what you did and the outcome>", success: true/false })
\`\`\`

### Step 2: Mark Task Complete
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`

## Constraints

- Focus only on this specific task
- Do not create new tasks unless absolutely necessary
- Report any issues via mcp__agent-reports__report_to_deputy_cto`;
}

/**
 * Build prompt for standard task runner (simplified from hourly-automation.js:1371-1516)
 */
function buildTaskRunnerPrompt(task, agentName, agentId, worktreePath = null) {
  const taskDetails = `[Task][task-runner-${agentName}][AGENT:${agentId}] You are an orchestrator processing an URGENT TODO task.

## Task Details

- **Task ID**: ${task.id}
- **Section**: ${task.section}
- **Title**: ${task.title}
- **Priority**: URGENT (spawned immediately by urgent-task-spawner hook)
${task.description ? `- **Description**: ${task.description}` : ''}`;

  const gitWorkflowBlock = worktreePath ? `
## Git Workflow

You are working in a git worktree on a feature branch.
Your working directory: ${worktreePath}
MCP tools access shared state in the main project directory.

When your work is complete:
1. \`git add <specific files>\` (never \`git add .\` or \`git add -A\`)
2. \`git commit -m "descriptive message"\`
3. Push and create PR:
\`\`\`
git push -u origin HEAD
gh pr create --base preview --head "$(git branch --show-current)" --title "${task.title}" --body "Automated: ${task.section} task (urgent)" 2>/dev/null || true
\`\`\`
` : '';

  const completionBlock = `## When Done

### Step 1: Summarize Your Work (MANDATORY)
\`\`\`
mcp__todo-db__summarize_work({ summary: "<concise description of what you did and the outcome>", success: true/false })
\`\`\`

### Step 2: Mark Task Complete
\`\`\`
mcp__todo-db__complete_task({ id: "${task.id}" })
\`\`\`
${gitWorkflowBlock}
## Constraints

- Focus only on this specific task
- Do not create new tasks unless absolutely necessary
- Report any issues via mcp__agent-reports__report_to_deputy_cto`;

  // Section-specific immediate actions
  const sectionActions = {
    'CODE-REVIEWER': `
## MANDATORY SUB-AGENT WORKFLOW

1. \`Task(subagent_type='investigator')\` - Research the task
2. \`Task(subagent_type='code-writer')\` - Implement the changes
3. \`Task(subagent_type='test-writer')\` - Add/update tests
4. \`Task(subagent_type='code-reviewer')\` - Review changes, commit
5. \`Task(subagent_type='project-manager')\` - Sync documentation`,

    'INVESTIGATOR & PLANNER': `
## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='investigator', prompt='${task.title}. ${task.description || ''}')
\`\`\``,

    'TEST-WRITER': `
## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='test-writer', prompt='${task.title}. ${task.description || ''}')
\`\`\`

Then after test-writer completes:
\`\`\`
Task(subagent_type='code-reviewer', prompt='Review the test changes')
\`\`\``,

    'PROJECT-MANAGER': `
## IMMEDIATE ACTION

Your first action MUST be:
\`\`\`
Task(subagent_type='project-manager', prompt='${task.title}. ${task.description || ''}')
\`\`\``,
  };

  const action = sectionActions[task.section] || `
## Your Role

You are the \`${agentName}\` agent. Complete the task described above using your expertise.
Use the Task tool to spawn the appropriate sub-agent: \`Task(subagent_type='${agentName}')\``;

  return `${taskDetails}\n${action}\n\n${completionBlock}`;
}

/**
 * Spawn a fire-and-forget Claude agent for a task.
 * Mirrors hourly-automation.js:1524-1587 but simplified for single-task use.
 */
function spawnTaskAgent(task) {
  const mapping = SECTION_AGENT_MAP[task.section];
  if (!mapping) return false;

  // Worktree setup (best-effort)
  let agentCwd = PROJECT_DIR;
  let agentMcpConfig = path.join(PROJECT_DIR, '.mcp.json');
  let worktreePath = null;

  try {
    const branchName = getFeatureBranchName(task.title, task.id);
    const worktree = createWorktree(branchName);
    worktreePath = worktree.path;
    agentCwd = worktree.path;
    agentMcpConfig = path.join(worktree.path, '.mcp.json');
    log(`Worktree ready at ${worktree.path} (branch ${branchName})`);
  } catch (err) {
    log(`Worktree creation failed, falling back to PROJECT_DIR: ${err.message}`);
  }

  // Register first to get agentId for prompt embedding
  const agentId = registerSpawn({
    type: mapping.agentType,
    hookType: HOOK_TYPES.TASK_RUNNER,
    description: `Urgent task: ${mapping.agent} - ${task.title}`,
    prompt: '',
    metadata: { taskId: task.id, section: task.section, worktreePath, urgent: true },
  });

  const prompt = mapping.agent === 'deputy-cto'
    ? buildDeputyCtoTaskPrompt(task, agentId)
    : buildTaskRunnerPrompt(task, mapping.agent, agentId, worktreePath);

  // Store prompt now that it's built
  updateAgent(agentId, { prompt });

  try {
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--mcp-config', agentMcpConfig,
      '--output-format', 'json',
      '-p',
      prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: agentCwd,
      env: {
        ...buildSpawnEnv(agentId),
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
      },
    });

    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running' });
    log(`Spawned ${mapping.agent} (PID ${claude.pid}) for task ${task.id}: "${task.title}"`);
    return true;
  } catch (err) {
    log(`Failed to spawn ${mapping.agent} for task ${task.id}: ${err.message}`);
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

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    const toolInput = hookInput.tool_input || {};

    // Only act on urgent priority tasks
    if (toolInput.priority !== 'urgent') {
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
    } catch {
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
      } catch {
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

    // Build task object for spawn
    const task = { id: taskId, section, title, description };

    const success = spawnTaskAgent(task);
    if (success) {
      log(`Successfully spawned agent for urgent task ${taskId}: "${title}" (section: ${section})`);
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
