/**
 * Agent Tracker - Shared module for tracking spawned Claude agents
 *
 * Used by hooks to register when they spawn Claude agents.
 * Data is stored in agent-tracker-history.json and read by the MCP server.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Configuration
const CONFIG = {
  HISTORY_FILE: path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json'),
  MAX_ENTRIES: 500,
  MAX_PROMPT_LENGTH: 50000, // 50KB max prompt storage
  MAX_HOOK_EXECUTIONS: 1000 // Keep last 1000 hook executions
};

/**
 * Agent types - must match MCP server AGENT_TYPES
 */
export const AGENT_TYPES = {
  TODO_PROCESSING: 'todo-processing',
  TODO_SYNTAX_FIX: 'todo-syntax-fix',
  COMPLIANCE_GLOBAL: 'compliance-global',
  COMPLIANCE_LOCAL: 'compliance-local',
  COMPLIANCE_MAPPING_FIX: 'compliance-mapping-fix',
  COMPLIANCE_MAPPING_REVIEW: 'compliance-mapping-review',
  TEST_FAILURE_JEST: 'test-failure-jest',
  TEST_FAILURE_VITEST: 'test-failure-vitest',
  TEST_FAILURE_PLAYWRIGHT: 'test-failure-playwright',
  ANTIPATTERN_HUNTER: 'antipattern-hunter',
  ANTIPATTERN_HUNTER_REPO: 'antipattern-hunter-repo',
  ANTIPATTERN_HUNTER_COMMIT: 'antipattern-hunter-commit',
  FEDERATION_MAPPER: 'federation-mapper',
  DEPUTY_CTO_REVIEW: 'deputy-cto-review',
  PLAN_EXECUTOR: 'plan-executor',
  CLAUDEMD_REFACTOR: 'claudemd-refactor',
  LINT_FIXER: 'lint-fixer',
  TASK_RUNNER_CODE_REVIEWER: 'task-runner-code-reviewer',
  TASK_RUNNER_INVESTIGATOR: 'task-runner-investigator',
  TASK_RUNNER_TEST_WRITER: 'task-runner-test-writer',
  TASK_RUNNER_PROJECT_MANAGER: 'task-runner-project-manager',
};

/**
 * Hook types - identifies which hook spawned the agent
 */
export const HOOK_TYPES = {
  TODO_MAINTENANCE: 'todo-maintenance',
  COMPLIANCE_CHECKER: 'compliance-checker',
  JEST_REPORTER: 'jest-reporter',
  VITEST_REPORTER: 'vitest-reporter',
  PLAYWRIGHT_REPORTER: 'playwright-reporter',
  ANTIPATTERN_HUNTER: 'antipattern-hunter',
  SCHEMA_MAPPER: 'schema-mapper',
  PRE_COMMIT_REVIEW: 'pre-commit-review',
  PLAN_EXECUTOR: 'plan-executor',
  HOURLY_AUTOMATION: 'hourly-automation',
  TASK_RUNNER: 'task-runner',
};

/**
 * Generate a unique agent ID
 * @returns {string}
 */
function generateAgentId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `agent-${timestamp}-${random}`;
}

/**
 * Generate a unique execution ID for hook executions
 * @returns {string}
 */
function generateExecutionId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `exec-${timestamp}-${random}`;
}

/**
 * Read the history file
 * @returns {object}
 */
function readHistory() {
  const defaultHistory = {
    agents: [],
    stats: { totalSpawns: 0, totalHookExecutions: 0 },
    hookExecutions: []
  };
  try {
    if (!fs.existsSync(CONFIG.HISTORY_FILE)) {
      return defaultHistory;
    }
    const content = fs.readFileSync(CONFIG.HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(content);
    // Validate structure - handle legacy format or corrupted files
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.agents)) {
      return defaultHistory;
    }
    // Ensure stats exists with all fields
    if (!parsed.stats) {
      parsed.stats = { totalSpawns: 0, totalHookExecutions: 0 };
    }
    if (parsed.stats.totalHookExecutions === undefined) {
      parsed.stats.totalHookExecutions = 0;
    }
    // Ensure hookExecutions array exists (migration for older files)
    if (!Array.isArray(parsed.hookExecutions)) {
      parsed.hookExecutions = [];
    }
    return parsed;
  } catch {
    return defaultHistory;
  }
}

/**
 * Write the history file
 * @param {object} history
 */
function writeHistory(history) {
  try {
    const dir = path.dirname(CONFIG.HISTORY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error(`[agent-tracker] Failed to write history: ${err.message}`);
  }
}

/**
 * Register a spawned agent
 *
 * @param {object} options
 * @param {string} options.type - Agent type from AGENT_TYPES
 * @param {string} options.hookType - Hook type from HOOK_TYPES
 * @param {string} options.description - Brief description of why agent was spawned
 * @param {string} options.prompt - Full prompt given to agent
 * @param {object} [options.metadata] - Additional metadata (e.g., failing tests, file paths)
 * @param {string} [options.projectDir] - Project directory (for session file matching)
 * @returns {string} The generated agent ID
 */
export function registerSpawn(options) {
  const {
    type,
    hookType,
    description,
    prompt,
    metadata = {},
    projectDir = process.cwd()
  } = options;

  // Validate required fields
  if (!type || !hookType || !description) {
    console.error('[agent-tracker] Missing required fields: type, hookType, description');
    return null;
  }

  const history = readHistory();
  const agentId = generateAgentId();

  const agent = {
    id: agentId,
    type,
    hookType,
    description,
    prompt: prompt ? prompt.substring(0, CONFIG.MAX_PROMPT_LENGTH) : null,
    promptTruncated: prompt && prompt.length > CONFIG.MAX_PROMPT_LENGTH,
    metadata,
    projectDir,
    timestamp: new Date().toISOString()
  };

  // Add to beginning (most recent first)
  history.agents.unshift(agent);

  // Enforce max entries (remove oldest)
  if (history.agents.length > CONFIG.MAX_ENTRIES) {
    history.agents = history.agents.slice(0, CONFIG.MAX_ENTRIES);
  }

  // Update stats
  history.stats.totalSpawns = (history.stats.totalSpawns || 0) + 1;

  writeHistory(history);

  return agentId;
}

/**
 * Get recent spawns (for debugging/logging)
 * @param {number} limit - Number of recent spawns to return
 * @returns {object[]}
 */
export function getRecentSpawns(limit = 10) {
  const history = readHistory();
  return history.agents.slice(0, limit).map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    timestamp: a.timestamp
  }));
}

/**
 * Check if a recent spawn exists with matching criteria
 * Useful for deduplication beyond cooldowns
 *
 * @param {object} criteria
 * @param {string} [criteria.type] - Agent type to match
 * @param {string} [criteria.descriptionContains] - Text to find in description
 * @param {number} [criteria.withinMinutes] - Time window (default: 60)
 * @returns {object|null} Matching agent or null
 */
export function findRecentSpawn(criteria) {
  const {
    type,
    descriptionContains,
    withinMinutes = 60
  } = criteria;

  const history = readHistory();
  const cutoff = Date.now() - (withinMinutes * 60 * 1000);

  return history.agents.find(a => {
    const spawnTime = new Date(a.timestamp).getTime();
    if (spawnTime < cutoff) return false;
    if (type && a.type !== type) return false;
    if (descriptionContains && !a.description.includes(descriptionContains)) return false;
    return true;
  }) || null;
}

/**
 * Register a hook execution
 *
 * @param {object} options
 * @param {string} options.hookType - Hook type from HOOK_TYPES
 * @param {string} options.status - 'success' | 'failure' | 'skipped'
 * @param {number} [options.durationMs] - Execution duration in milliseconds
 * @param {object} [options.metadata] - Additional metadata (e.g., error message, skip reason)
 * @returns {string} The generated execution ID
 */
export function registerHookExecution(options) {
  const {
    hookType,
    status,
    durationMs = 0,
    metadata = {}
  } = options;

  // Validate required fields
  if (!hookType || !status) {
    console.error('[agent-tracker] Missing required fields: hookType, status');
    return null;
  }

  // Validate status
  const validStatuses = ['success', 'failure', 'skipped'];
  if (!validStatuses.includes(status)) {
    console.error(`[agent-tracker] Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    return null;
  }

  const history = readHistory();
  const executionId = generateExecutionId();

  const execution = {
    id: executionId,
    hookType,
    status,
    timestamp: new Date().toISOString(),
    durationMs,
    metadata
  };

  // Add to beginning (most recent first)
  history.hookExecutions.unshift(execution);

  // Enforce max entries (remove oldest)
  if (history.hookExecutions.length > CONFIG.MAX_HOOK_EXECUTIONS) {
    history.hookExecutions = history.hookExecutions.slice(0, CONFIG.MAX_HOOK_EXECUTIONS);
  }

  // Update stats
  history.stats.totalHookExecutions = (history.stats.totalHookExecutions || 0) + 1;

  writeHistory(history);

  return executionId;
}

/**
 * Get recent hook executions (for debugging/logging)
 * @param {number} limit - Number of recent executions to return
 * @param {string} [hookType] - Optional filter by hook type
 * @returns {object[]}
 */
export function getRecentHookExecutions(limit = 10, hookType = null) {
  const history = readHistory();
  let executions = history.hookExecutions;

  if (hookType) {
    executions = executions.filter(e => e.hookType === hookType);
  }

  return executions.slice(0, limit).map(e => ({
    id: e.id,
    hookType: e.hookType,
    status: e.status,
    durationMs: e.durationMs,
    timestamp: e.timestamp
  }));
}

/**
 * Get hook execution statistics for a time period
 * @param {number} hours - Hours to look back
 * @returns {object} Statistics by hook type
 */
export function getHookExecutionStats(hours = 24) {
  const history = readHistory();
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);

  const stats = {
    total: 0,
    success: 0,
    failure: 0,
    skipped: 0,
    byHook: {}
  };

  for (const execution of history.hookExecutions) {
    const execTime = new Date(execution.timestamp).getTime();
    if (execTime < cutoff) continue;

    stats.total++;
    stats[execution.status]++;

    // Aggregate by hook type
    if (!stats.byHook[execution.hookType]) {
      stats.byHook[execution.hookType] = {
        total: 0,
        success: 0,
        failure: 0,
        skipped: 0,
        totalDurationMs: 0
      };
    }
    stats.byHook[execution.hookType].total++;
    stats.byHook[execution.hookType][execution.status]++;
    stats.byHook[execution.hookType].totalDurationMs += execution.durationMs || 0;
  }

  return stats;
}

export default {
  AGENT_TYPES,
  HOOK_TYPES,
  registerSpawn,
  getRecentSpawns,
  findRecentSpawn,
  registerHookExecution,
  getRecentHookExecutions,
  getHookExecutionStats
};
