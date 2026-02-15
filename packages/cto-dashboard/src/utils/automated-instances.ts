/**
 * Automated Instances Utility
 *
 * Reads hook configurations, run counts from agent-tracker,
 * and interval adjustments from usage-optimizer.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AutomationCooldowns } from './data-reader.js';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const AUTOMATION_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');

// ============================================================================
// Types
// ============================================================================

export type InstanceTrigger = 'scheduled' | 'commit' | 'failure' | 'prompt' | 'file-change';

export interface AutomatedInstance {
  type: string;                          // Display name
  runs24h: number;                       // Count from agent-tracker
  nextRun: string;                       // "in Xm" or "on commit" etc.
  delta: string | null;                  // "+5m34s" or "-2m10s" or null
  freqAdj: string | null;                // "+15% slower" or "baseline" or null
  trigger: InstanceTrigger;              // Type of trigger
}

export interface AutomatedInstancesData {
  instances: AutomatedInstance[];
  usageTarget: number;                   // Target % (e.g., 85)
  currentProjected: number | null;       // Current projected % at reset
  adjustingDirection: 'up' | 'down' | 'stable';  // Which way intervals are adjusting
  hasData: boolean;
}

interface AgentHistoryEntry {
  id: string;
  type: string;
  hookType: string;
  timestamp: string;
}

interface AgentHistory {
  agents: AgentHistoryEntry[];
}

interface AutomationState {
  lastRun?: number;
  lastClaudeMdRefactor?: number;
  lastTriageCheck?: number;
  lastTaskRunnerCheck?: number;
  lastLintCheck?: number;
}

interface AutomationConfigFile {
  version: number;
  defaults?: Partial<AutomationCooldowns>;
  effective?: Partial<AutomationCooldowns>;
  adjustment?: {
    factor?: number;
    target_pct?: number;
    projected_at_reset?: number;
    constraining_metric?: '5h' | '7d';
    last_updated?: string;
  };
}

// ============================================================================
// Instance Definitions
// ============================================================================

// Map of instance types to their configuration
const INSTANCE_DEFINITIONS: Array<{
  type: string;
  agentTypes: string[];              // agent-tracker types to count
  hookTypes?: string[];              // hook types to count
  trigger: InstanceTrigger;
  stateKey: keyof AutomationState | null;
  cooldownKey: keyof AutomationCooldowns | null;
  defaultMinutes: number | null;
}> = [
  {
    type: 'Pre-Commit Hook',
    agentTypes: ['deputy-cto-review'],
    hookTypes: ['PreCommit'],
    trigger: 'commit',
    stateKey: null,
    cooldownKey: null,
    defaultMinutes: null,
  },
  {
    type: 'CLAUDE.md Refactor',
    agentTypes: ['claudemd-refactor'],
    trigger: 'scheduled',
    stateKey: 'lastClaudeMdRefactor',
    cooldownKey: 'hourly_tasks',
    defaultMinutes: 55,
  },
  {
    type: 'Todo Maintenance',
    agentTypes: ['todo-processing', 'todo-syntax-fix'],
    trigger: 'scheduled',
    stateKey: 'lastTaskRunnerCheck',
    cooldownKey: 'todo_maintenance',
    defaultMinutes: 15,
  },
  {
    type: 'Antipattern Hunter',
    agentTypes: ['antipattern-hunter', 'antipattern-hunter-repo', 'antipattern-hunter-commit'],
    trigger: 'scheduled',
    stateKey: null,
    cooldownKey: 'antipattern_hunter',
    defaultMinutes: 360,
  },
  {
    type: 'Triage Check',
    agentTypes: [],  // Tracked differently
    trigger: 'scheduled',
    stateKey: 'lastTriageCheck',
    cooldownKey: 'triage_check',
    defaultMinutes: 5,
  },
  {
    type: 'Lint Checker',
    agentTypes: ['lint-fixer'],
    trigger: 'scheduled',
    stateKey: 'lastLintCheck',
    cooldownKey: 'lint_checker',
    defaultMinutes: 30,
  },
  {
    type: 'Test Suite',
    agentTypes: ['test-failure-jest', 'test-failure-vitest', 'test-failure-playwright'],
    trigger: 'failure',
    stateKey: null,
    cooldownKey: null,
    defaultMinutes: null,
  },
  {
    type: 'Compliance Checker',
    agentTypes: ['compliance-global', 'compliance-local', 'compliance-mapping-fix', 'compliance-mapping-review'],
    trigger: 'file-change',
    stateKey: null,
    cooldownKey: null,
    defaultMinutes: null,
  },
];

// ============================================================================
// Main Function
// ============================================================================

/**
 * Get automated instances data including run counts, next run times,
 * deltas from baseline, and frequency adjustments.
 */
export function getAutomatedInstances(): AutomatedInstancesData {
  // Get agent run counts
  const runCounts = getAgentRunCounts();

  // Get automation state
  const state = getAutomationState();

  // Get config (defaults and effective cooldowns)
  const config = getAutomationConfig();

  // Calculate instances
  const now = Date.now();
  const instances: AutomatedInstance[] = [];

  for (const def of INSTANCE_DEFINITIONS) {
    // Count runs from agent types
    let runs24h = 0;
    for (const agentType of def.agentTypes) {
      runs24h += runCounts[agentType] || 0;
    }

    // Build next run string
    let nextRun = '';
    let delta: string | null = null;
    let freqAdj: string | null = null;

    if (def.trigger === 'commit') {
      nextRun = 'on commit';
    } else if (def.trigger === 'failure') {
      nextRun = 'on failure';
    } else if (def.trigger === 'file-change') {
      nextRun = 'on change';
    } else if (def.trigger === 'prompt') {
      nextRun = 'on prompt';
    } else if (def.trigger === 'scheduled' && def.stateKey && def.cooldownKey) {
      // Calculate next run for scheduled tasks
      const lastRun = state[def.stateKey];
      const effectiveMinutes = config.effective?.[def.cooldownKey] ?? def.defaultMinutes ?? 0;
      const defaultMinutes = config.defaults?.[def.cooldownKey] ?? def.defaultMinutes ?? 0;

      if (lastRun && effectiveMinutes > 0) {
        const nextRunMs = lastRun + (effectiveMinutes * 60 * 1000);
        const secondsUntil = Math.floor((nextRunMs - now) / 1000);

        if (secondsUntil <= 0) {
          nextRun = 'now';
        } else {
          nextRun = `in ${formatDelta(secondsUntil)}`;
        }

        // Calculate delta from default
        const deltaMinutes = effectiveMinutes - defaultMinutes;
        if (deltaMinutes !== 0) {
          const sign = deltaMinutes > 0 ? '+' : '';
          delta = `${sign}${formatDelta(Math.abs(deltaMinutes) * 60)}`;
        }

        // Calculate frequency adjustment percentage
        if (defaultMinutes > 0 && effectiveMinutes !== defaultMinutes) {
          const pctChange = Math.round(((effectiveMinutes - defaultMinutes) / defaultMinutes) * 100);
          if (pctChange !== 0) {
            const direction = pctChange > 0 ? 'slower' : 'faster';
            freqAdj = `${pctChange > 0 ? '+' : ''}${pctChange}% ${direction}`;
          }
        }
      } else {
        nextRun = 'N/A';
      }
    } else if (def.trigger === 'scheduled') {
      nextRun = 'scheduled';
      freqAdj = 'baseline';
    }

    instances.push({
      type: def.type,
      runs24h,
      nextRun,
      delta,
      freqAdj,
      trigger: def.trigger,
    });
  }

  // Calculate adjusting direction based on factor
  const factor = config.adjustment?.factor ?? 1.0;
  let adjustingDirection: 'up' | 'down' | 'stable' = 'stable';
  if (factor > 1.05) {
    adjustingDirection = 'down'; // Factor > 1 means faster activity, so intervals going down
  } else if (factor < 0.95) {
    adjustingDirection = 'up';   // Factor < 1 means slower activity, so intervals going up
  }

  return {
    instances,
    usageTarget: config.adjustment?.target_pct ?? 90,
    currentProjected: config.adjustment?.projected_at_reset ?? null,
    adjustingDirection,
    hasData: instances.length > 0,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get agent run counts from agent-tracker for the last 24 hours.
 */
function getAgentRunCounts(): Record<string, number> {
  const counts: Record<string, number> = {};

  if (!fs.existsSync(AGENT_TRACKER_PATH)) {
    return counts;
  }

  try {
    const content = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
    const history = JSON.parse(content) as AgentHistory;

    const now = Date.now();
    const cutoff24h = now - 24 * 60 * 60 * 1000;

    for (const agent of history.agents || []) {
      const agentTime = new Date(agent.timestamp).getTime();
      if (agentTime >= cutoff24h) {
        counts[agent.type] = (counts[agent.type] || 0) + 1;
      }
    }
  } catch {
    // Ignore errors
  }

  return counts;
}

/**
 * Get automation state (last run times).
 */
function getAutomationState(): AutomationState {
  const state: AutomationState = {};

  if (!fs.existsSync(AUTOMATION_STATE_PATH)) {
    return state;
  }

  try {
    const content = fs.readFileSync(AUTOMATION_STATE_PATH, 'utf8');
    return JSON.parse(content) as AutomationState;
  } catch {
    return state;
  }
}

/**
 * Get automation config with defaults and effective cooldowns.
 */
function getAutomationConfig(): AutomationConfigFile {
  const defaults: Partial<AutomationCooldowns> = {
    hourly_tasks: 55,
    triage_check: 5,
    antipattern_hunter: 360,
    schema_mapper: 1440,
    lint_checker: 30,
    todo_maintenance: 15,
    task_runner: 60,
    triage_per_item: 60,
  };

  const config: AutomationConfigFile = {
    version: 1,
    defaults,
    effective: defaults,
  };

  if (!fs.existsSync(AUTOMATION_CONFIG_PATH)) {
    return config;
  }

  try {
    const content = fs.readFileSync(AUTOMATION_CONFIG_PATH, 'utf8');
    const loaded = JSON.parse(content) as AutomationConfigFile;

    if (loaded.defaults) {
      config.defaults = { ...defaults, ...loaded.defaults };
    }
    if (loaded.effective) {
      config.effective = { ...defaults, ...loaded.effective };
    }
    if (loaded.adjustment) {
      config.adjustment = loaded.adjustment;
    }

    return config;
  } catch {
    return config;
  }
}

/**
 * Format seconds as compact duration.
 */
function formatDelta(seconds: number): string {
  if (seconds < 0) return '0s';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}m${secs}s` : `${minutes}m`;
  }
  return `${secs}s`;
}
