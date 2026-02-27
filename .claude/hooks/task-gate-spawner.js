#!/usr/bin/env node
/**
 * PostToolUse Hook: Task Gate Spawner
 *
 * Fires after mcp__todo-db__create_task. When a task enters 'pending_review'
 * status (i.e., it was NOT from a gate-bypass creator), spawns a lightweight
 * Haiku agent to review and approve/kill/escalate the task.
 *
 * Complements urgent-task-spawner.js:
 *   - urgent-task-spawner checks toolInput.priority === 'urgent' (from bypass creators)
 *   - task-gate-spawner checks tool_response.status === 'pending_review' (non-bypass creators)
 *   - No overlap: urgent tasks from authorized creators go to urgent-spawner;
 *     everything else goes to gate-spawner
 *
 * PostToolUse hooks MUST always exit 0 (the tool already ran, blocking is meaningless).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { registerSpawn, updateAgent, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'task-gate-spawner.log');
const PROXY_PORT = process.env.GENTYR_PROXY_PORT || 18080;

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [task-gate-spawner] ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal
  }
}

function buildSpawnEnv(agentId) {
  const hooksDir = path.join(PROJECT_DIR, '.claude', 'hooks');
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
    CLAUDE_PROJECT_DIR: PROJECT_DIR,
    CLAUDE_SPAWNED_SESSION: 'true',
    CLAUDE_AGENT_ID: agentId,
    HTTPS_PROXY: `http://localhost:${PROXY_PORT}`,
    HTTP_PROXY: `http://localhost:${PROXY_PORT}`,
    NO_PROXY: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: path.join(process.env.HOME || '/tmp', '.claude', 'proxy-certs', 'ca.pem'),
    PATH: guardedPath,
  };
}

/**
 * Extract a keyword from the task title for CTO session search.
 * Takes the first 2-3 meaningful words.
 */
function extractKeyword(title) {
  const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'and', 'or', 'in', 'on', 'of', 'add', 'fix', 'update', 'implement', 'create', 'remove', 'delete']);
  const words = title.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
  return words.slice(0, 3).join(' ') || title.substring(0, 30);
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

    // Parse the response to check status
    let taskStatus = null;
    let taskId = null;
    let taskTitle = '';
    let taskSection = '';
    let taskDescription = '';
    let assignedBy = '';

    try {
      const response = hookInput.tool_response;
      if (response && typeof response === 'object') {
        taskStatus = response.status;
        taskId = response.id;
        taskTitle = response.title || '';
        taskSection = response.section || '';
        taskDescription = response.description || '';
        assignedBy = response.assigned_by || '';
      } else if (typeof response === 'string') {
        const parsed = JSON.parse(response);
        taskStatus = parsed.status;
        taskId = parsed.id;
        taskTitle = parsed.title || '';
        taskSection = parsed.section || '';
        taskDescription = parsed.description || '';
        assignedBy = parsed.assigned_by || '';
      }
    } catch {
      // Try MCP content array format
      try {
        const response = hookInput.tool_response;
        if (response?.content && Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'text' && block.text) {
              const parsed = JSON.parse(block.text);
              taskStatus = parsed.status;
              taskId = parsed.id;
              taskTitle = parsed.title || '';
              taskSection = parsed.section || '';
              taskDescription = parsed.description || '';
              assignedBy = parsed.assigned_by || '';
              break;
            }
          }
        }
      } catch {
        // Give up
      }
    }

    // Only act on pending_review tasks (non-bypassed)
    if (taskStatus !== 'pending_review') {
      process.exit(0);
    }

    if (!taskId) {
      log('pending_review task detected but could not extract task ID');
      process.exit(0);
    }

    log(`Gate review needed for task ${taskId}: "${taskTitle}" (section: ${taskSection}, by: ${assignedBy})`);

    // Register the gate agent
    const agentId = registerSpawn({
      type: AGENT_TYPES.TASK_GATE,
      hookType: 'task-gate',
      description: `Gate review: ${taskTitle}`,
      prompt: '',
      metadata: { taskId, section: taskSection, assignedBy },
    });

    const keyword = extractKeyword(taskTitle);

    const gatePrompt = `[Task][task-gate][AGENT:${agentId}] Review task ${taskId}.

"${taskTitle}" | Section: ${taskSection} | By: ${assignedBy}
Description: ${taskDescription || '(none)'}

## Checks (do all 3, then decide)
1. DUPLICATES: Call mcp__todo-db__list_tasks({ section: "${taskSection}", status: "pending" }). If a very similar task exists, KILL.
2. STABILITY: Call mcp__user-feedback__check_feature_stability with file paths or feature name from the description. If feature is locked, KILL.
3. CTO INTENT: Call mcp__agent-tracker__search_cto_sessions({ query: "${keyword}", project_directory: "${PROJECT_DIR}" }). If CTO recently discussed this topic, APPROVE.

## Decision (pick ONE, then exit)
- APPROVE: mcp__todo-db__gate_approve_task({ id: "${taskId}" })
- KILL: mcp__todo-db__gate_kill_task({ id: "${taskId}", reason: "..." })
- UNSURE: mcp__todo-db__gate_escalate_task({ id: "${taskId}", reason: "..." })

If no stability lock and no duplicate, default to APPROVE. Err toward approval — only kill clear duplicates or stability-locked features.`;

    // Store prompt
    updateAgent(agentId, { prompt: gatePrompt });

    // Spawn lightweight Haiku gate agent
    const mcpConfig = path.join(PROJECT_DIR, '.mcp.json');
    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '--model', 'claude-haiku-4-5-20251001',
      '--mcp-config', mcpConfig,
      '--output-format', 'json',
      '-p',
      gatePrompt,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: {
        ...buildSpawnEnv(agentId),
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
      },
    });

    claude.unref();
    updateAgent(agentId, { pid: claude.pid, status: 'running' });
    log(`Spawned gate agent (PID ${claude.pid}) for task ${taskId}`);
  } catch (err) {
    process.stderr.write(`[task-gate-spawner] Error: ${err.message}\n${err.stack}\n`);
  }

  // Always exit 0 — PostToolUse hooks must never block
  process.exit(0);
});
