/**
 * Automated Instances Utility
 *
 * Reads hook configurations, run counts from agent-tracker,
 * and interval adjustments from usage-optimizer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
  untilNext: string;                     // "23m", "1h15m", "now", "on commit", "-"
  freqAdj: string | null;                // "+15% slower", "static 45m", "baseline", "no data", or null
  trigger: InstanceTrigger;              // Type of trigger
}

export interface AutomatedInstancesData {
  instances: AutomatedInstance[];
  usageTarget: number;                   // Target % (e.g., 90)
  currentProjected: number | null;       // Current projected % at reset
  adjustingDirection: 'up' | 'down' | 'stable';  // Which way intervals are adjusting
  hasData: boolean;
  tokensByType: Record<string, number>;  // display name → total tokens (24h, for bar chart)
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
  lastPreviewPromotionCheck?: number;
  lastStagingPromotionCheck?: number;
  lastStagingHealthCheck?: number;
  lastProductionHealthCheck?: number;
  lastStandaloneAntipatternHunt?: number;
  lastStandaloneComplianceCheck?: number;
  lastFeedbackCheck?: number;
}

interface AutomationModeEntry {
  mode: 'load_balanced' | 'static';
  static_minutes?: number;
  set_at?: string;
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
  modes?: Record<string, AutomationModeEntry>;
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
  // --- Event-triggered automations ---
  {
    type: 'Pre-Commit Hook',
    agentTypes: ['deputy-cto-review'],
    hookTypes: ['PreCommit'],
    trigger: 'commit',
    stateKey: null,
    cooldownKey: 'pre_commit_review',
    defaultMinutes: 5,
  },
  {
    type: 'Test Suite',
    agentTypes: ['test-failure-jest', 'test-failure-vitest', 'test-failure-playwright'],
    trigger: 'failure',
    stateKey: null,
    cooldownKey: 'test_failure_reporter',
    defaultMinutes: 120,
  },
  {
    type: 'Compliance (Hook)',
    agentTypes: ['compliance-global', 'compliance-local', 'compliance-mapping-fix', 'compliance-mapping-review'],
    trigger: 'file-change',
    stateKey: null,
    cooldownKey: 'compliance_checker_file',
    defaultMinutes: 10080,
  },
  {
    type: 'Todo Maintenance',
    agentTypes: ['todo-processing', 'todo-syntax-fix'],
    trigger: 'file-change',
    stateKey: null,
    cooldownKey: 'todo_maintenance',
    defaultMinutes: 15,
  },
  // --- Scheduled automations ---
  {
    type: 'Triage Check',
    agentTypes: [],
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
    type: 'CLAUDE.md Refactor',
    agentTypes: ['claudemd-refactor'],
    trigger: 'scheduled',
    stateKey: 'lastClaudeMdRefactor',
    cooldownKey: 'hourly_tasks',
    defaultMinutes: 55,
  },
  {
    type: 'Task Runner',
    agentTypes: ['task-runner-code-reviewer', 'task-runner-investigator', 'task-runner-test-writer', 'task-runner-project-manager'],
    trigger: 'scheduled',
    stateKey: 'lastTaskRunnerCheck',
    cooldownKey: 'task_runner',
    defaultMinutes: 60,
  },
  {
    type: 'Production Health',
    agentTypes: ['production-health-monitor'],
    trigger: 'scheduled',
    stateKey: 'lastProductionHealthCheck',
    cooldownKey: 'production_health_monitor',
    defaultMinutes: 60,
  },
  {
    type: 'Compliance (Sched.)',
    agentTypes: ['standalone-compliance-checker'],
    trigger: 'scheduled',
    stateKey: 'lastStandaloneComplianceCheck',
    cooldownKey: 'standalone_compliance_checker',
    defaultMinutes: 60,
  },
  {
    type: 'User Feedback',
    agentTypes: ['feedback-orchestrator'],
    trigger: 'scheduled',
    stateKey: 'lastFeedbackCheck',
    cooldownKey: 'user_feedback',
    defaultMinutes: 120,
  },
  {
    type: 'Antipattern Hunter',
    agentTypes: ['antipattern-hunter', 'antipattern-hunter-repo', 'antipattern-hunter-commit', 'standalone-antipattern-hunter'],
    trigger: 'scheduled',
    stateKey: 'lastStandaloneAntipatternHunt',
    cooldownKey: 'standalone_antipattern_hunter',
    defaultMinutes: 180,
  },
  {
    type: 'Staging Health',
    agentTypes: ['staging-health-monitor'],
    trigger: 'scheduled',
    stateKey: 'lastStagingHealthCheck',
    cooldownKey: 'staging_health_monitor',
    defaultMinutes: 180,
  },
  {
    type: 'Preview Promotion',
    agentTypes: ['preview-promotion'],
    trigger: 'scheduled',
    stateKey: 'lastPreviewPromotionCheck',
    cooldownKey: 'preview_promotion',
    defaultMinutes: 360,
  },
  {
    type: 'Staging Promotion',
    agentTypes: ['staging-promotion'],
    trigger: 'scheduled',
    stateKey: 'lastStagingPromotionCheck',
    cooldownKey: 'staging_promotion',
    defaultMinutes: 1200,
  },
];

// ============================================================================
// Main Function
// ============================================================================

/**
 * Get automated instances data including run counts, time until next run,
 * and frequency adjustments.
 */
export function getAutomatedInstances(): AutomatedInstancesData {
  const runCounts = getAgentRunCounts();
  const state = getAutomationState();
  const config = getAutomationConfig();
  // getAutomationConfig() always provides hardcoded defaults in effective,
  // so we always know the baseline frequencies.

  const now = Date.now();
  const instances: AutomatedInstance[] = [];

  for (const def of INSTANCE_DEFINITIONS) {
    // Count runs from agent types
    let runs24h = 0;
    for (const agentType of def.agentTypes) {
      runs24h += runCounts[agentType] || 0;
    }

    let untilNext = '-';
    let freqAdj: string | null = null;

    if (def.trigger === 'commit') {
      untilNext = 'on commit';
    } else if (def.trigger === 'failure') {
      untilNext = 'on failure';
    } else if (def.trigger === 'file-change') {
      untilNext = 'on change';
    } else if (def.trigger === 'prompt') {
      untilNext = 'on prompt';
    } else if (def.trigger === 'scheduled' && def.stateKey && def.cooldownKey) {
      const lastRun = state[def.stateKey];
      const effectiveMinutes = config.effective?.[def.cooldownKey] ?? def.defaultMinutes ?? 0;
      const defaultMinutes = config.defaults?.[def.cooldownKey] ?? def.defaultMinutes ?? 0;

      const modeEntry = config.modes?.[def.cooldownKey];

      if (lastRun && effectiveMinutes > 0) {
        const nextRunMs = lastRun + (effectiveMinutes * 60 * 1000);
        const secondsUntil = Math.floor((nextRunMs - now) / 1000);

        if (secondsUntil <= 0) {
          untilNext = 'now';
        } else {
          untilNext = formatDuration(secondsUntil);
        }

        freqAdj = computeFreqAdj(effectiveMinutes, defaultMinutes, modeEntry);
      } else {
        untilNext = 'pending';
        freqAdj = computeFreqAdj(effectiveMinutes, defaultMinutes, modeEntry);
      }
    } else if (def.trigger === 'scheduled') {
      // Scheduled but missing stateKey or cooldownKey
      untilNext = 'pending';
      freqAdj = 'baseline';
    }

    // For event-triggered hooks with a cooldownKey, compute freqAdj from optimizer data
    if (def.trigger !== 'scheduled' && def.cooldownKey && def.defaultMinutes !== null) {
      const effectiveMinutes = config.effective?.[def.cooldownKey] ?? def.defaultMinutes;
      const defaultMinutes = config.defaults?.[def.cooldownKey] ?? def.defaultMinutes;
      const modeEntry = config.modes?.[def.cooldownKey];
      freqAdj = computeFreqAdj(effectiveMinutes, defaultMinutes, modeEntry);
    }

    instances.push({
      type: def.type,
      runs24h,
      untilNext,
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
    currentProjected: config.adjustment?.projected_at_reset != null
      ? Math.round(config.adjustment.projected_at_reset * 100)
      : null,
    adjustingDirection,
    hasData: instances.length > 0,
    tokensByType: {},
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
    preview_promotion: 360,
    staging_promotion: 1200,
    staging_health_monitor: 180,
    production_health_monitor: 60,
    standalone_antipattern_hunter: 180,
    standalone_compliance_checker: 60,
    user_feedback: 120,
    test_failure_reporter: 120,
    pre_commit_review: 5,
    compliance_checker_file: 10080,
    compliance_checker_spec: 10080,
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
    if (loaded.modes) {
      config.modes = loaded.modes;
    }

    return config;
  } catch {
    return config;
  }
}

/**
 * Compute frequency adjustment display string.
 */
function computeFreqAdj(
  effectiveMinutes: number,
  defaultMinutes: number,
  modeEntry: AutomationModeEntry | undefined,
): string {
  if (modeEntry?.mode === 'static') {
    return `static ${modeEntry?.static_minutes ?? effectiveMinutes}m`;
  }
  if (defaultMinutes > 0 && effectiveMinutes !== defaultMinutes) {
    const pctChange = Math.round(((effectiveMinutes - defaultMinutes) / defaultMinutes) * 100);
    if (pctChange !== 0) {
      const direction = pctChange > 0 ? 'slower' : 'faster';
      return `${pctChange > 0 ? '+' : ''}${pctChange}% ${direction}`;
    }
  }
  return 'baseline';
}

/**
 * Format seconds as compact duration.
 */
function formatDuration(seconds: number): string {
  if (seconds < 0) return '0s';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

// ============================================================================
// Token Usage by Automation Type
// ============================================================================

interface SessionEntry {
  type?: string;
  message?: {
    content?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content?: string;
}

function getSessionDir(): string {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

/**
 * Build a reverse lookup from raw agent type → display name using INSTANCE_DEFINITIONS.
 */
function buildAgentTypeToDisplayName(): Map<string, string> {
  const map = new Map<string, string>();
  for (const def of INSTANCE_DEFINITIONS) {
    for (const agentType of def.agentTypes) {
      map.set(agentType, def.type);
    }
  }
  return map;
}

/**
 * Get token usage aggregated by automation display name (24h).
 * Reads session JSONL files, extracts [Task][agent-type] prefixes from the
 * first user message, sums all message.usage tokens per session, then
 * rolls up into INSTANCE_DEFINITIONS display names.
 */
export async function getAutomationTokenUsage(): Promise<Record<string, number>> {
  const sessionDir = getSessionDir();
  const since = Date.now() - 24 * 60 * 60 * 1000;

  if (!fs.existsSync(sessionDir)) {
    return {};
  }

  const agentTypeMap = buildAgentTypeToDisplayName();
  const rawTokens: Record<string, number> = {};

  let files: string[];
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return {};
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.mtime.getTime() < since) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n').filter(l => l.trim());

    let agentType: string | null = null;
    let totalTokens = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;

        // Extract agent type from first user message
        if (agentType === null && (entry.type === 'human' || entry.type === 'user')) {
          const msg = typeof entry.message?.content === 'string'
            ? entry.message.content
            : entry.content;
          if (msg) {
            const match = msg.match(/^\[Task\]\[([^\]]+)\]/);
            if (match?.[1]) {
              agentType = match[1];
            } else {
              // Not a task-triggered session — skip entirely
              break;
            }
          }
        }

        // Sum token usage
        const usage = entry.message?.usage;
        if (usage) {
          totalTokens += (usage.input_tokens || 0)
            + (usage.output_tokens || 0)
            + (usage.cache_read_input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0);
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (agentType && totalTokens > 0) {
      rawTokens[agentType] = (rawTokens[agentType] || 0) + totalTokens;
    }
  }

  // Roll up raw agent types into display names
  const byDisplayName: Record<string, number> = {};
  for (const [rawType, tokens] of Object.entries(rawTokens)) {
    const displayName = agentTypeMap.get(rawType) || rawType;
    byDisplayName[displayName] = (byDisplayName[displayName] || 0) + tokens;
  }

  return byDisplayName;
}
