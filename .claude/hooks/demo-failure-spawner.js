#!/usr/bin/env node
/**
 * PostToolUse Hook: Demo Failure Auto-Repair Spawner
 *
 * Fires after mcp__playwright__check_demo_result and
 * mcp__playwright__check_demo_batch_result. Detects failed scenarios,
 * deduplicates against in-flight repairs, and spawns demo-manager agents
 * in isolated worktrees.
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { registerSpawn, updateAgent, findRecentSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { createWorktree } from './lib/worktree-manager.js';
import { getFeatureBranchName } from './lib/feature-branch-helper.js';
import { buildSpawnEnv } from './lib/spawn-env.js';
import { shouldAllowSpawn } from './lib/memory-pressure.js';

// Try to import better-sqlite3 for DB access
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // Non-fatal
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'demo-failure-spawner.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [demo-failure-spawner] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal
  }
}

/**
 * Check if a repair is already in-flight for this scenario.
 * Checks both agent-tracker history and todo.db.
 */
function isRepairInFlight(scenarioId) {
  // Check 1: Recent spawn in agent-tracker
  const recentSpawn = findRecentSpawn({
    type: AGENT_TYPES.TASK_RUNNER_DEMO_MANAGER,
    descriptionContains: scenarioId,
    withinMinutes: 120,
  });
  if (recentSpawn) return true;

  // Also check for DEMO_REPAIR type from hourly validation
  const recentRepair = findRecentSpawn({
    type: AGENT_TYPES.DEMO_REPAIR,
    descriptionContains: scenarioId,
    withinMinutes: 120,
  });
  if (recentRepair) return true;

  // Check 2: Pending/in_progress DEMO-MANAGER task mentioning scenario
  if (Database && fs.existsSync(TODO_DB_PATH)) {
    try {
      const db = new Database(TODO_DB_PATH, { readonly: true });
      const row = db.prepare(
        "SELECT id FROM tasks WHERE section = 'DEMO-MANAGER' AND status IN ('pending', 'in_progress') AND (title LIKE ? OR description LIKE ?) LIMIT 1"
      ).get(`%${scenarioId}%`, `%${scenarioId}%`);
      db.close();
      if (row) return true;
    } catch {
      // Non-fatal: proceed without dedup
    }
  }

  return false;
}

/**
 * Spawn a demo-manager repair agent for a failed scenario.
 */
function spawnRepairAgent(scenario) {
  const { id: scenarioId, title, error } = scenario;

  // Create worktree
  let worktreePath;
  try {
    const branchName = getFeatureBranchName('demo-repair', scenarioId.slice(0, 8));
    const worktree = createWorktree(branchName, undefined, { skipFetch: true });
    worktreePath = worktree.path;
  } catch (err) {
    log(`Failed to create worktree for scenario ${scenarioId}: ${err.message}`);
    return false;
  }

  // Insert DEMO-MANAGER task for tracking
  let taskId = null;
  if (Database && fs.existsSync(TODO_DB_PATH)) {
    try {
      const db = new Database(TODO_DB_PATH);
      taskId = 'dm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const now = new Date();
      db.prepare(`
        INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, started_timestamp, priority)
        VALUES (?, 'DEMO-MANAGER', 'in_progress', ?, ?, 'demo-failure', ?, ?, ?, 'normal')
      `).run(taskId, `Repair: ${title}`, `Scenario: ${scenarioId}\nError: ${error || 'Unknown'}`, now.toISOString(), Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000));
      db.close();
    } catch (err) {
      log(`Failed to create tracking task: ${err.message}`);
      // Non-fatal: continue with spawn
    }
  }

  // Register spawn
  const agentId = registerSpawn({
    type: AGENT_TYPES.TASK_RUNNER_DEMO_MANAGER,
    hookType: HOOK_TYPES.DEMO_FAILURE,
    description: `Demo repair: ${title} (${scenarioId})`,
    prompt: '',
    projectDir: worktreePath,
    metadata: { scenarioId, scenarioTitle: title, error, taskId },
  });

  const agentMcpConfig = path.join(worktreePath, '.mcp.json');
  const prompt = [
    `[Task][task-runner-demo-manager][AGENT:${agentId}] You are a demo repair agent. A demo scenario failed.`,
    ``,
    `**Failed Scenario:**`,
    `- ID: ${scenarioId}`,
    `- Title: ${title}`,
    `- Error: ${error || 'Unknown error'}`,
    taskId ? `- Tracking Task: ${taskId}` : '',
    ``,
    `## Instructions`,
    ``,
    `Follow the repair protocol in your agent definition:`,
    `1. Run preflight_check to verify environment`,
    `2. Read the failed .demo.ts file`,
    `3. Diagnose from the error output`,
    `4. Fix the .demo.ts file`,
    `5. Re-run the scenario headless to verify`,
    `6. If you cannot fix it (app code issue), report via report_to_deputy_cto`,
    ``,
    `## When Done`,
    ``,
    `1. Spawn project-manager to commit, push, create PR, self-merge, and clean up worktree`,
    `2. Call mcp__todo-db__summarize_work with your results`,
    taskId ? `3. Call mcp__todo-db__complete_task({ id: "${taskId}" })` : '',
  ].filter(Boolean).join('\n');

  // Store prompt
  updateAgent(agentId, { prompt });

  try {
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--agent-name', 'demo-manager',
      ...(fs.existsSync(agentMcpConfig) ? ['--mcp-config', agentMcpConfig] : []),
      '--output-format', 'json',
      '-p', prompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: worktreePath,
      env: buildSpawnEnv(agentId, { projectDir: PROJECT_DIR }),
    });

    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running' });
    log(`Spawned repair agent ${agentId} (PID ${claude.pid}) for scenario "${title}" (${scenarioId})`);

    // Background fetch for worktree
    try {
      const fetchProc = spawn('git', ['fetch', 'origin', '--quiet'], {
        cwd: worktreePath,
        stdio: 'ignore',
        detached: true,
      });
      fetchProc.unref();
    } catch { /* non-fatal */ }

    return true;
  } catch (err) {
    log(`Failed to spawn repair agent for ${scenarioId}: ${err.message}`);
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
    const toolName = hookInput.tool_name || '';

    // Parse tool response
    let response = hookInput.tool_response;
    if (typeof response === 'string') {
      try { response = JSON.parse(response); } catch { /* leave as string */ }
    }
    // Handle MCP content array format
    if (response && response.content && Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          try { response = JSON.parse(block.text); break; } catch { /* continue */ }
        }
      }
    }

    if (!response || typeof response !== 'object') {
      process.exit(0);
    }

    // Extract failed scenarios
    const failedScenarios = [];

    if (toolName.includes('check_demo_batch_result')) {
      // Batch result: check scenarios array
      const scenarios = response.scenarios || response.results || [];
      for (const s of scenarios) {
        if (s.status === 'failed' || s.success === false) {
          failedScenarios.push({
            id: s.scenario_id || s.id || 'unknown',
            title: s.title || s.scenario_title || 'Unknown scenario',
            error: s.failure_summary || s.error || s.message || null,
          });
        }
      }
    } else if (toolName.includes('check_demo_result')) {
      // Single result
      if (response.status === 'failed' || response.success === false) {
        failedScenarios.push({
          id: response.scenario_id || response.id || 'unknown',
          title: response.title || response.scenario_title || 'Unknown scenario',
          error: response.failure_summary || response.error || response.message || null,
        });
      }
    }

    if (failedScenarios.length === 0) {
      process.exit(0);
    }

    log(`Detected ${failedScenarios.length} failed scenario(s)`);

    // Process up to 3 failed scenarios
    let spawned = 0;
    for (const scenario of failedScenarios.slice(0, 3)) {
      // Dedup check
      if (isRepairInFlight(scenario.id)) {
        log(`Skipping "${scenario.title}" (${scenario.id}) — repair already in flight`);
        continue;
      }

      // Memory pressure check
      const memCheck = shouldAllowSpawn({ priority: 'normal', context: 'demo-failure' });
      if (!memCheck.allowed) {
        log(`Skipping "${scenario.title}" — ${memCheck.reason}`);
        continue;
      }

      if (spawnRepairAgent(scenario)) {
        spawned++;
      }
    }

    if (spawned > 0) {
      log(`Spawned ${spawned} repair agent(s)`);
    }
  } catch (err) {
    process.stderr.write(`[demo-failure-spawner] Error: ${err.message}\n${err.stack}\n`);
  }

  // Always exit 0 — PostToolUse hooks must never block
  process.exit(0);
});
