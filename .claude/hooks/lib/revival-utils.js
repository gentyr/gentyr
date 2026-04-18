/**
 * Shared revival utilities for GENTYR session recovery.
 *
 * Extracted from session-reviver.js for use in:
 *   - stop-continue-hook.js (inline revival)
 *   - session-reviver.js (hourly revival)
 *   - revival-daemon.js (crash recovery)
 *
 * @module lib/revival-utils
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { AGENT_TYPES, HOOK_TYPES } from '../agent-tracker.js';
import { enqueueSession } from './session-queue.js';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Build the context prompt injected when a session is resumed.
 * Tells the agent how long it was interrupted and to verify its task status.
 *
 * @param {object} params
 * @param {string} params.reason - Revival reason key
 * @param {string} params.interruptedAt - ISO timestamp of interruption
 * @param {string} [params.taskId] - Task ID to check
 * @returns {string} Revival prompt text
 */
export function buildRevivalPrompt({ reason, interruptedAt, taskId }) {
  const elapsedMs = Date.now() - new Date(interruptedAt).getTime();
  const hours = Math.floor(elapsedMs / (60 * 60 * 1000));
  const minutes = Math.floor((elapsedMs % (60 * 60 * 1000)) / (60 * 1000));
  const elapsed = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const reasonText = {
    quota_interrupted: 'API quota exhaustion',
    process_already_dead: 'unexpected process death',
    account_recovered: 'all API accounts were exhausted',
    inline_revival: 'API quota exhaustion (inline revival)',
  }[reason] || reason;

  let prompt = `[SESSION REVIVED] This session was interrupted ${elapsed} ago due to ${reasonText} and is now being resumed.\n\n`;
  prompt += `IMPORTANT: Before continuing any work, you MUST first verify that your assigned task has not already been completed by another agent while you were interrupted. `;

  if (taskId) {
    prompt += `Check the status of task ${taskId} using mcp__todo-db__get_task. `;
    prompt += `If the task status is 'completed', report that it was already handled and exit immediately. `;
    prompt += `If the task is still 'pending' or 'in_progress', proceed with the work where you left off.`;
  } else {
    prompt += `Check mcp__todo-db__list_tasks for your category to see if your work has been completed. `;
    prompt += `If it has, exit immediately. Otherwise, proceed where you left off.`;
  }

  return prompt;
}

/**
 * Enqueue a resumed Claude session via the centralized session queue.
 *
 * @param {string} sessionId - Session UUID to resume
 * @param {string} agentId - Original agent ID (used for metadata/logging only)
 * @param {function} log - Logging function
 * @param {string} revivalPrompt - Prompt to inject on resume
 * @param {string} [resumeCwd] - CWD for the resumed session (worktree path)
 * @param {object} [options]
 * @param {string} [options.projectDir] - Project directory for env resolution
 * @param {object} [options.extraEnv] - Extra env vars for spawn
 * @param {string} [options.source] - Source identifier for queue logging
 * @param {object} [options.metadata] - Additional metadata for the queue item
 * @returns {boolean} Whether the item was spawned immediately (drained)
 */
export function spawnResumedSession(sessionId, agentId, log, revivalPrompt, resumeCwd = null, options = {}) {
  const projectDir = options.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Use original worktree CWD if it still exists, otherwise fall back to main project
  const effectiveCwd = (resumeCwd && fs.existsSync(resumeCwd)) ? resumeCwd : projectDir;

  // If worktree was cleaned up, warn the agent
  let prompt = revivalPrompt;
  if (resumeCwd && !fs.existsSync(resumeCwd)) {
    prompt += '\n\nNOTE: Your original worktree has been cleaned up. You are running from the main project directory. Create a new worktree if you need to make changes.';
  }

  try {
    const result = enqueueSession({
      title: `Revival: ${sessionId.slice(0, 8)}`,
      agentType: AGENT_TYPES.SESSION_REVIVED,
      hookType: HOOK_TYPES.SESSION_REVIVER,
      tagContext: 'session-revived',
      source: options.source || 'revival-utils',
      spawnType: 'resume',
      resumeSessionId: sessionId,
      lane: 'revival',
      priority: 'urgent',
      prompt,
      cwd: effectiveCwd,
      mcpConfig: path.join(effectiveCwd, '.mcp.json'),
      projectDir,
      worktreePath: (resumeCwd && fs.existsSync(resumeCwd)) ? resumeCwd : null,
      extraEnv: options.extraEnv,
      metadata: {
        originalAgentId: agentId,
        originalSessionId: sessionId,
        ...(options.metadata || {}),
      },
    });

    const spawned = result.drained.spawned > 0;
    if (spawned) {
      log(`  Enqueued and spawned revival of session ${sessionId.slice(0, 8)}... (queueId: ${result.queueId})`);
    } else {
      log(`  Enqueued revival of session ${sessionId.slice(0, 8)}... (queueId: ${result.queueId}, at capacity)`);
    }
    return spawned;
  } catch (err) {
    log(`  Failed to enqueue revival of session ${sessionId.slice(0, 8)}...: ${err.message}`);
    return false;
  }
}

/**
 * Discover the session directory for a project.
 *
 * @param {string} projectDir - Absolute project directory path
 * @returns {string|null} Session directory path or null
 */
export function getSessionDir(projectDir) {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

/**
 * Find a session JSONL file by agent ID marker in the session directory.
 *
 * @param {string} sessionDir - Directory containing session JSONL files
 * @param {string} agentId - Agent ID to search for
 * @returns {string|null} Full path to matching session file or null
 */
export function findSessionFileByAgentId(sessionDir, agentId) {
  const marker = `[AGENT:${agentId}]`;
  let files;
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch (err) {
    console.error('[revival-utils] Warning:', err.message);
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(2000);
      const bytesRead = fs.readSync(fd, buf, 0, 2000, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      if (head.includes(marker)) return filePath;
    } catch (err) {
      console.error('[revival-utils] Warning:', err.message);
      // skip
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return null;
}

/**
 * Extract session ID from a JSONL transcript path.
 *
 * @param {string} transcriptPath - Path to a session JSONL file
 * @returns {string|null} UUID session ID or null
 */
export function extractSessionIdFromPath(transcriptPath) {
  if (!transcriptPath) return null;
  const basename = path.basename(transcriptPath, '.jsonl');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return uuidRegex.test(basename) ? basename : null;
}

/**
 * Resolve taskId for an agentId by scanning agent-tracker history.
 *
 * @param {string} agentId - Agent ID to look up
 * @param {string} [projectDir] - Project directory for history file
 * @returns {string|null} Task ID or null
 */
export function resolveTaskIdForAgent(agentId, projectDir) {
  if (!agentId) return null;
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const historyPath = path.join(dir, '.claude', 'state', 'agent-tracker-history.json');
  try {
    if (!fs.existsSync(historyPath)) return null;
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!Array.isArray(history.agents)) return null;
    const agent = history.agents.find(a => a.id === agentId);
    return agent?.metadata?.taskId || null;
  } catch (err) {
    console.error('[revival-utils] Warning:', err.message);
    return null;
  }
}
