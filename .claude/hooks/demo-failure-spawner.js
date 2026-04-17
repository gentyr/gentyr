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
import { findRecentSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
import { createWorktree } from './lib/worktree-manager.js';
import { getFeatureBranchName } from './lib/feature-branch-helper.js';
import { shouldAllowSpawn } from './lib/memory-pressure.js';
import { enqueueSession } from './lib/session-queue.js';

// Try to import better-sqlite3 for DB access
let Database = null;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error('[demo-failure-spawner] Warning:', err.message);
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
  } catch (err) {
    console.error('[demo-failure-spawner] Warning:', err.message);
    // Non-fatal
  }
}

/**
 * Query registered prerequisites for a given scenario from user-feedback.db.
 */
function queryPrerequisites(scenarioId) {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
  if (!Database || !fs.existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    // Get scenario's persona_id
    const scenario = db.prepare('SELECT persona_id FROM demo_scenarios WHERE id = ?').get(scenarioId);
    const personaId = scenario?.persona_id;
    // Get all applicable prerequisites (global + persona + scenario)
    const rows = db.prepare(`
      SELECT scope, description, command, health_check, run_as_background
      FROM demo_prerequisites
      WHERE scope = 'global'
         OR (scope = 'persona' AND persona_id = ?)
         OR (scope = 'scenario' AND scenario_id = ?)
      ORDER BY sort_order
    `).all(personaId || '', scenarioId);
    db.close();
    return rows;
  } catch (err) { console.error('[demo-failure-spawner] Warning: failed to load prerequisites:', err.message); return []; }
}

/**
 * Format prerequisites as a text block for repair prompts.
 */
function formatPrerequisites(prereqs) {
  if (!prereqs.length) return '';
  const lines = prereqs.map(p => {
    let line = `  - [${p.scope}] ${p.description || p.command}`;
    if (p.command) line += `\n    Command: \`${p.command}\``;
    if (p.health_check) line += `\n    Health check: \`${p.health_check}\``;
    if (p.run_as_background) line += ` (background)`;
    return line;
  });
  return [
    ``,
    `**Registered Prerequisites:**`,
    ...lines,
    ``,
    `## Prerequisite Diagnosis`,
    `Before modifying the .demo.ts file, check if the failure is caused by a prerequisite issue:`,
    `1. Run \`list_prerequisites\` to see all registered prerequisites`,
    `2. Run \`run_prerequisites\` to verify they pass`,
    `3. If a prerequisite is missing or wrong, use \`register_prerequisite\` / \`update_prerequisite\` to fix it`,
    `4. Only modify the .demo.ts file if prerequisites pass and the failure is in the test code`,
  ].join('\n');
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
    } catch (_) { /* cleanup - failure expected */
      // Non-fatal: proceed without dedup
    }
  }

  return false;
}

/**
 * Spawn a demo-manager repair agent for a failed scenario.
 */
function spawnRepairAgent(scenario) {
  const { id: scenarioId, title, error, test_file } = scenario;

  // Create worktree
  let worktreePath;
  try {
    const branchName = getFeatureBranchName('demo-repair', scenarioId.slice(0, 8));
    const worktree = createWorktree(branchName, undefined, { fetchTimeout: 10000 });
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

  const agentMcpConfig = path.join(worktreePath, '.mcp.json');

  try {
    enqueueSession({
      title: `Demo repair: ${title} (${scenarioId})`,
      agentType: AGENT_TYPES.TASK_RUNNER_DEMO_MANAGER,
      hookType: HOOK_TYPES.DEMO_FAILURE,
      tagContext: 'task-runner-demo-manager',
      source: 'demo-failure-spawner',
      priority: 'low',
      cwd: worktreePath,
      worktreePath,
      projectDir: PROJECT_DIR,
      mcpConfig: fs.existsSync(agentMcpConfig) ? agentMcpConfig : undefined,
      agent: 'demo-manager',
      metadata: { scenarioId, scenarioTitle: title, error, taskId },
      buildPrompt: (agentId) => {
        const prereqs = queryPrerequisites(scenarioId);
        const prereqBlock = formatPrerequisites(prereqs);
        const isStall = error && error.includes('Stalled:');
        const stallGuidance = isStall ? [
          ``,
          `## STALL KILL DETECTED`,
          ``,
          `This demo was killed by the GENTYR stall detector because it produced no output for 45+ seconds.`,
          `The demo IS progressing internally, but the stall detector cannot see it.`,
          ``,
          `**Root cause**: A long-running operation (login flow, polling, redirect chain) runs inside a single`,
          `test.step() without emitting any stdout/stderr. The stall detector sees silence and kills it.`,
          ``,
          `**Fix priority (try in order):**`,
          `1. Break the monolithic test.step() into multiple smaller steps (each boundary resets the timer)`,
          `2. Add \`console.warn('[demo-progress] ...')\` checkpoints every 10-15s inside helper functions`,
          `3. Both — sub-steps for structure, console.warn for fine-grained progress inside helpers`,
          ``,
          `**Do NOT increase timeouts.** The stall detector is correct — if nothing is reporting progress,`,
          `we want to fail fast and fix the reporting, not hide the problem behind longer waits.`,
          ``,
          `See "Progress Checkpoints (MANDATORY)" in your agent definition for patterns and examples.`,
        ] : [];
        return [
          `[Automation][task-runner-demo-manager][AGENT:${agentId}] You are a demo repair agent. A demo scenario failed.`,
          ``,
          `**Failed Scenario:**`,
          `- ID: ${scenarioId}`,
          `- Title: ${title}`,
          `- Error: ${error || 'Unknown error'}`,
          test_file ? `- Test File: ${test_file}` : '',
          taskId ? `- Tracking Task: ${taskId}` : '',
          prereqBlock,
          ...stallGuidance,
          ``,
          `## Instructions`,
          ``,
          `Follow the repair protocol in your agent definition:`,
          `1. Check registered prerequisites via \`list_prerequisites\` — verify all pass via \`run_prerequisites\``,
          `2. If a prerequisite is missing or broken, fix it via \`register_prerequisite\` / \`update_prerequisite\``,
          `3. Run preflight_check to verify environment`,
          `4. Read the failed .demo.ts file`,
          `5. Diagnose from the error output`,
          `6. Fix the .demo.ts file or prerequisite configuration`,
          `7. Re-run the scenario headless to verify`,
          `8. If you cannot fix it (app code issue), report via report_to_deputy_cto`,
          ``,
          `## When Done`,
          ``,
          `1. Spawn project-manager to commit, push, create PR, self-merge, and clean up worktree`,
          `2. Call mcp__todo-db__summarize_work with your results`,
          taskId ? `3. Call mcp__todo-db__complete_task({ id: "${taskId}" })` : '',
        ].filter(Boolean).join('\n');
      },
    });

    log(`Enqueued repair agent for scenario "${title}" (${scenarioId})`);

    return true;
  } catch (err) {
    log(`Failed to enqueue repair agent for ${scenarioId}: ${err.message}`);
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
      try { response = JSON.parse(response); } catch (err) {
        console.error('[demo-failure-spawner] Warning:', err.message);
        /* leave as string */
      }
    }
    // Handle MCP content array format
    if (response && response.content && Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          try { response = JSON.parse(block.text); break; } catch (err) {
            console.error('[demo-failure-spawner] Warning:', err.message);
            /* continue */
          }
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
            test_file: s.test_file || null,
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
          test_file: response.test_file || null,
        });
      }
    } else if (toolName === 'mcp__playwright__run_demo') {
      // run_demo immediate failure (e.g., prerequisite failure)
      if (response.success === false) {
        // Extract scenario info from response or tool input
        const scenarioId = response.scenario_id || hookInput.tool_input?.scenario_id || 'unknown';
        let scenarioTitle = response.title || response.scenario_title || null;
        let testFile = response.test_file || null;

        // Look up missing title/test_file from user-feedback.db
        if ((!scenarioTitle || !testFile) && scenarioId !== 'unknown' && Database) {
          try {
            const dbPath = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
            if (fs.existsSync(dbPath)) {
              const db = new Database(dbPath, { readonly: true });
              const row = db.prepare('SELECT title, test_file FROM demo_scenarios WHERE id = ?').get(scenarioId);
              db.close();
              if (row) {
                if (!scenarioTitle) scenarioTitle = row.title;
                if (!testFile) testFile = row.test_file;
              }
            }
          } catch (err) { console.error('[demo-failure-spawner] Warning: failed to load scenario metadata:', err.message); }
        }

        failedScenarios.push({
          id: scenarioId,
          title: scenarioTitle || 'Unknown scenario',
          error: response.error || response.message || response.failure_summary || null,
          test_file: testFile,
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
