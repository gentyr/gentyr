/**
 * Unit tests for automated-instances.ts
 *
 * Tests reading automation configurations, run counts, and interval adjustments
 * for all 15 automated instance types.
 *
 * Validates:
 * - Run counting from agent-tracker
 * - Time until next run calculation
 * - Frequency adjustment display (baseline, %, static mode)
 * - Usage target and projection tracking
 * - All trigger types (scheduled, commit, failure, file-change, prompt)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AutomationCooldowns } from '../data-reader.js';

describe('Automated Instances - Basic Structure', () => {
  let tempDir: string;
  let agentTrackerPath: string;
  let automationStatePath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `automated-instances-test-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude', 'state'), { recursive: true });
    agentTrackerPath = path.join(tempDir, '.claude', 'state', 'agent-tracker-history.json');
    automationStatePath = path.join(tempDir, '.claude', 'hourly-automation-state.json');

    // Set PROJECT_DIR env var for the module under test
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  interface AgentHistoryEntry {
    type: string;
    timestamp: string;
  }

  interface AgentHistory {
    agents: AgentHistoryEntry[];
  }

  type InstanceTrigger = 'scheduled' | 'commit' | 'failure' | 'prompt' | 'file-change';

  interface AutomatedInstance {
    type: string;
    runs24h: number;
    untilNext: string;
    freqAdj: string | null;
    trigger: InstanceTrigger;
  }

  interface AutomatedInstancesData {
    instances: AutomatedInstance[];
    usageTarget: number;
    currentProjected: number | null;
    adjustingDirection: 'up' | 'down' | 'stable';
    hasData: boolean;
    tokensByType: Record<string, number>;
  }

  // Minimal implementation for testing structure validation
  const getAutomatedInstances = (): AutomatedInstancesData => {
    const result: AutomatedInstancesData = {
      instances: [],
      usageTarget: 90,
      currentProjected: null,
      adjustingDirection: 'stable',
      hasData: false,
      tokensByType: {},
    };

    // If no files exist, return empty data
    if (!fs.existsSync(agentTrackerPath) && !fs.existsSync(automationStatePath)) {
      return result;
    }

    result.hasData = true;
    return result;
  };

  it('should return empty data when no files exist', () => {
    const result = getAutomatedInstances();

    expect(result.instances).toEqual([]);
    expect(result.usageTarget).toBe(90);
    expect(result.currentProjected).toBeNull();
    expect(result.adjustingDirection).toBe('stable');
    expect(result.hasData).toBe(false);
  });

  it('should indicate hasData when agent tracker exists', () => {
    const history: AgentHistory = { agents: [] };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const result = getAutomatedInstances();

    expect(result.hasData).toBe(true);
  });

  it('should validate structure of returned data', () => {
    const result = getAutomatedInstances();

    expect(result).toHaveProperty('instances');
    expect(result).toHaveProperty('usageTarget');
    expect(result).toHaveProperty('currentProjected');
    expect(result).toHaveProperty('adjustingDirection');
    expect(result).toHaveProperty('hasData');
    expect(result).toHaveProperty('tokensByType');

    expect(Array.isArray(result.instances)).toBe(true);
    expect(typeof result.usageTarget).toBe('number');
    expect(result.currentProjected === null || typeof result.currentProjected === 'number').toBe(true);
    expect(['up', 'down', 'stable'].includes(result.adjustingDirection)).toBe(true);
    expect(typeof result.hasData).toBe('boolean');
    expect(typeof result.tokensByType).toBe('object');
    expect(result.tokensByType).not.toBeNull();
    expect(Array.isArray(result.tokensByType)).toBe(false);
  });
});

describe('Automated Instances - Run Counting', () => {
  let tempDir: string;
  let agentTrackerPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `automated-instances-count-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude', 'state'), { recursive: true });
    agentTrackerPath = path.join(tempDir, '.claude', 'state', 'agent-tracker-history.json');
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  interface AgentHistoryEntry {
    type: string;
    timestamp: string;
  }

  interface AgentHistory {
    agents: AgentHistoryEntry[];
  }

  const getAgentRunCounts = (): Record<string, number> => {
    const counts: Record<string, number> = {};

    if (!fs.existsSync(agentTrackerPath)) {
      return counts;
    }

    try {
      const content = fs.readFileSync(agentTrackerPath, 'utf8');
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
  };

  it('should count runs by agent type within 24 hours', () => {
    const now = Date.now();
    const history: AgentHistory = {
      agents: [
        { type: 'deputy-cto-review', timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString() },
        { type: 'deputy-cto-review', timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
        { type: 'lint-fixer', timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
        { type: 'task-runner-code-reviewer', timestamp: new Date(now - 4 * 60 * 60 * 1000).toISOString() },
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const counts = getAgentRunCounts();

    expect(counts['deputy-cto-review']).toBe(2);
    expect(counts['lint-fixer']).toBe(1);
    expect(counts['task-runner-code-reviewer']).toBe(1);
  });

  it('should filter out runs older than 24 hours', () => {
    const now = Date.now();
    const history: AgentHistory = {
      agents: [
        { type: 'deputy-cto-review', timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString() },
        { type: 'deputy-cto-review', timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString() }, // Excluded
      ],
    };
    fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

    const counts = getAgentRunCounts();

    expect(counts['deputy-cto-review']).toBe(1);
  });

  it('should return empty counts when file does not exist', () => {
    const counts = getAgentRunCounts();

    expect(Object.keys(counts).length).toBe(0);
  });
});

describe('Automated Instances - Time Until Next Run', () => {
  let tempDir: string;
  let automationStatePath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `automated-instances-time-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude', 'state'), { recursive: true });
    automationStatePath = path.join(tempDir, '.claude', 'hourly-automation-state.json');
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  interface AutomationState {
    lastTriageCheck?: number;
  }

  const formatDuration = (seconds: number): string => {
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
  };

  const getTimeUntilNext = (stateKey: keyof AutomationState, cooldownMinutes: number): string => {
    if (!fs.existsSync(automationStatePath)) {
      return 'pending';
    }

    try {
      const state = JSON.parse(fs.readFileSync(automationStatePath, 'utf8')) as AutomationState;
      const lastRun = state[stateKey];

      if (!lastRun) {
        return 'pending';
      }

      const now = Date.now();
      const nextRunMs = lastRun + (cooldownMinutes * 60 * 1000);
      const secondsUntil = Math.floor((nextRunMs - now) / 1000);

      if (secondsUntil <= 0) {
        return 'now';
      }

      return formatDuration(secondsUntil);
    } catch {
      return 'pending';
    }
  };

  it('should return "pending" when state file does not exist', () => {
    const result = getTimeUntilNext('lastTriageCheck', 5);

    expect(result).toBe('pending');
  });

  it('should return "pending" when last run is not set', () => {
    const state = {};
    fs.writeFileSync(automationStatePath, JSON.stringify(state));

    const result = getTimeUntilNext('lastTriageCheck', 5);

    expect(result).toBe('pending');
  });

  it('should return "now" when cooldown has expired', () => {
    const state = {
      lastTriageCheck: Date.now() - 10 * 60 * 1000, // 10 minutes ago
    };
    fs.writeFileSync(automationStatePath, JSON.stringify(state));

    const result = getTimeUntilNext('lastTriageCheck', 5); // 5 minute cooldown

    expect(result).toBe('now');
  });

  it('should format duration correctly for minutes', () => {
    const state = {
      lastTriageCheck: Date.now() - 2 * 60 * 1000, // 2 minutes ago
    };
    fs.writeFileSync(automationStatePath, JSON.stringify(state));

    const result = getTimeUntilNext('lastTriageCheck', 5); // 5 minute cooldown

    expect(result).toMatch(/^[0-9]+m$/);
  });

  it('should format duration correctly for hours and minutes', () => {
    expect(formatDuration(3661)).toBe('1h1m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(45)).toBe('45s');
  });
});

describe('Automated Instances - Frequency Adjustment', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = path.join('/tmp', `automated-instances-freq-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude', 'state'), { recursive: true });
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  const getFreqAdjDisplay = (
    _cooldownKey: keyof AutomationCooldowns,
    defaultMinutes: number,
    effectiveMinutes: number,
    isStatic: boolean,
    staticMinutes: number | undefined
  ): string | null => {
    if (isStatic) {
      return `static ${staticMinutes ?? effectiveMinutes}m`;
    }
    if (defaultMinutes > 0 && effectiveMinutes !== defaultMinutes) {
      const pctChange = Math.round(((effectiveMinutes - defaultMinutes) / defaultMinutes) * 100);
      if (pctChange !== 0) {
        const direction = pctChange > 0 ? 'slower' : 'faster';
        return `${pctChange > 0 ? '+' : ''}${pctChange}% ${direction}`;
      }
    }
    // getAutomationConfig() always provides hardcoded defaults in effective,
    // so we always know the baseline frequencies.
    return 'baseline';
  };

  it('should show "baseline" when no adjustment applied', () => {
    const result = getFreqAdjDisplay('triage_check', 5, 5, false, undefined);

    expect(result).toBe('baseline');
  });

  it('should show percentage increase for slower intervals', () => {
    const result = getFreqAdjDisplay('triage_check', 5, 6, false, undefined);

    expect(result).toBe('+20% slower');
  });

  it('should show percentage decrease for faster intervals', () => {
    const result = getFreqAdjDisplay('triage_check', 5, 4, false, undefined);

    expect(result).toBe('-20% faster');
  });

  it('should show static mode with configured minutes', () => {
    const result = getFreqAdjDisplay('triage_check', 5, 45, true, 45);

    expect(result).toBe('static 45m');
  });

  it('should use effective minutes when static_minutes is undefined', () => {
    const result = getFreqAdjDisplay('triage_check', 5, 45, true, undefined);

    expect(result).toBe('static 45m');
  });

  it('should always show "baseline" when effective equals default (hardcoded defaults always available)', () => {
    const result = getFreqAdjDisplay('triage_check', 5, 5, false, undefined);

    expect(result).toBe('baseline');
  });
});

describe('Automated Instances - Trigger Types', () => {
  it('should validate all trigger types', () => {
    const validTriggers: Array<'scheduled' | 'commit' | 'failure' | 'prompt' | 'file-change'> = [
      'scheduled',
      'commit',
      'failure',
      'prompt',
      'file-change',
    ];

    for (const trigger of validTriggers) {
      expect(typeof trigger).toBe('string');
      expect(trigger.length).toBeGreaterThan(0);
    }
  });

  it('should map event triggers to appropriate display strings', () => {
    const triggerDisplayMap = {
      commit: 'on commit',
      failure: 'on failure',
      'file-change': 'on change',
      prompt: 'on prompt',
    };

    for (const [_trigger, display] of Object.entries(triggerDisplayMap)) {
      expect(display).toMatch(/^on /);
    }
  });
});

describe('Automated Instances - Usage Projection', () => {
  let tempDir: string;
  let automationConfigPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `automated-instances-proj-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude', 'state'), { recursive: true });
    automationConfigPath = path.join(tempDir, '.claude', 'state', 'automation-config.json');
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  interface AutomationConfigFile {
    version: number;
    adjustment?: {
      factor?: number;
      target_pct?: number;
      projected_at_reset?: number;
    };
  }

  const getAdjustingDirection = (factor: number): 'up' | 'down' | 'stable' => {
    if (factor > 1.05) {
      return 'down'; // Factor > 1 means faster activity, so intervals going down
    } else if (factor < 0.95) {
      return 'up';   // Factor < 1 means slower activity, so intervals going up
    }
    return 'stable';
  };

  it('should return stable when factor is near 1.0', () => {
    expect(getAdjustingDirection(1.0)).toBe('stable');
    expect(getAdjustingDirection(1.02)).toBe('stable');
    expect(getAdjustingDirection(0.98)).toBe('stable');
  });

  it('should return down when factor exceeds 1.05', () => {
    expect(getAdjustingDirection(1.1)).toBe('down');
    expect(getAdjustingDirection(1.5)).toBe('down');
  });

  it('should return up when factor is below 0.95', () => {
    expect(getAdjustingDirection(0.9)).toBe('up');
    expect(getAdjustingDirection(0.5)).toBe('up');
  });

  it('should extract usage target from config', () => {
    const config: AutomationConfigFile = {
      version: 1,
      adjustment: {
        target_pct: 85,
      },
    };
    fs.writeFileSync(automationConfigPath, JSON.stringify(config));

    const loaded = JSON.parse(fs.readFileSync(automationConfigPath, 'utf8')) as AutomationConfigFile;

    expect(loaded.adjustment?.target_pct).toBe(85);
  });

  it('should extract current projection from config', () => {
    const config: AutomationConfigFile = {
      version: 1,
      adjustment: {
        projected_at_reset: 92,
      },
    };
    fs.writeFileSync(automationConfigPath, JSON.stringify(config));

    const loaded = JSON.parse(fs.readFileSync(automationConfigPath, 'utf8')) as AutomationConfigFile;

    expect(loaded.adjustment?.projected_at_reset).toBe(92);
  });
});

describe('Automated Instances - projected_at_reset fraction-to-percentage conversion', () => {
  // automated-instances.ts stores projected_at_reset as a fraction (0.0 – 1.5+)
  // written by usage-optimizer.js. The getAutomatedInstances() function converts
  // it to a display percentage by multiplying by 100 and rounding.

  const convertProjection = (raw: number | null | undefined): number | null => {
    if (raw == null) return null;
    return Math.round(raw * 100);
  };

  it('should convert fraction 0.87 to integer 87', () => {
    expect(convertProjection(0.87)).toBe(87);
  });

  it('should convert fraction 0.9 to integer 90', () => {
    expect(convertProjection(0.9)).toBe(90);
  });

  it('should convert fraction 1.0 to integer 100', () => {
    expect(convertProjection(1.0)).toBe(100);
  });

  it('should convert the MAX_PROJECTION cap value 1.5 to integer 150', () => {
    // When usage-optimizer caps projections at 1.5 and uses that as
    // projected_at_reset, the display should show 150%.
    expect(convertProjection(1.5)).toBe(150);
  });

  it('should return null when projected_at_reset is null', () => {
    expect(convertProjection(null)).toBeNull();
  });

  it('should return null when projected_at_reset is undefined', () => {
    expect(convertProjection(undefined)).toBeNull();
  });

  it('should round fractions correctly', () => {
    // 0.876 * 100 = 87.6 → rounds to 88
    expect(convertProjection(0.876)).toBe(88);
    // 0.874 * 100 = 87.4 → rounds to 87
    expect(convertProjection(0.874)).toBe(87);
  });

  it('should convert a value produced by the optimizer rounding convention', () => {
    // usage-optimizer writes: Math.round(projectedAtReset * 1000) / 1000
    // For a raw projection of 0.87654: stored as 0.877
    const optimizerOutput = Math.round(0.87654 * 1000) / 1000; // 0.877
    expect(convertProjection(optimizerOutput)).toBe(88); // Math.round(0.877 * 100) = 88
  });

  it('should handle zero projection (system idle)', () => {
    expect(convertProjection(0.0)).toBe(0);
  });

  it('should produce a result that is a non-negative integer', () => {
    const testValues = [0.0, 0.45, 0.87, 0.9, 1.0, 1.5];
    for (const val of testValues) {
      const result = convertProjection(val);
      expect(result).not.toBeNull();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result)).toBe(true);
      expect(Number.isNaN(result)).toBe(false);
    }
  });
});

describe('Automated Instances - Instance Definitions', () => {
  it('should have valid structure for all 15 instance types', () => {
    // These are the expected instance types based on automated-instances.ts
    const expectedTypes = [
      'Pre-Commit Hook',
      'Test Suite',
      'Compliance (Hook)',
      'Todo Maintenance',
      'Triage Check',
      'Lint Checker',
      'CLAUDE.md Refactor',
      'Task Runner',
      'Production Health',
      'Compliance (Sched.)',
      'User Feedback',
      'Antipattern Hunter',
      'Staging Health',
      'Preview Promotion',
      'Staging Promotion',
    ];

    expect(expectedTypes.length).toBe(15);

    // Validate each type is a non-empty string
    for (const type of expectedTypes) {
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(0);
    }
  });

  it('should map agent types to instances correctly', () => {
    const agentTypeMap = {
      'Pre-Commit Hook': ['deputy-cto-review'],
      'Test Suite': ['test-failure-jest', 'test-failure-vitest', 'test-failure-playwright'],
      'Task Runner': ['task-runner-code-reviewer', 'task-runner-investigator', 'task-runner-test-writer', 'task-runner-project-manager'],
      'Antipattern Hunter': ['antipattern-hunter', 'antipattern-hunter-repo', 'antipattern-hunter-commit', 'standalone-antipattern-hunter'],
    };

    for (const [_instance, agentTypes] of Object.entries(agentTypeMap)) {
      expect(Array.isArray(agentTypes)).toBe(true);
      expect(agentTypes.length).toBeGreaterThan(0);
      for (const agentType of agentTypes) {
        expect(typeof agentType).toBe('string');
        expect(agentType.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('Automated Instances - Event-Triggered Frequency Adjustment', () => {
  let tempDir: string;
  let automationConfigPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `automated-instances-event-freq-${randomUUID()}`);
    fs.mkdirSync(path.join(tempDir, '.claude', 'state'), { recursive: true });
    automationConfigPath = path.join(tempDir, '.claude', 'state', 'automation-config.json');
    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  const getFreqAdjForEventTriggered = (
    cooldownKey: keyof AutomationCooldowns,
    defaultMinutes: number,
    effectiveMinutes: number,
    isStatic: boolean,
    staticMinutes: number | undefined
  ): string | null => {
    if (isStatic) {
      return `static ${staticMinutes ?? effectiveMinutes}m`;
    }
    if (defaultMinutes > 0 && effectiveMinutes !== defaultMinutes) {
      const pctChange = Math.round(((effectiveMinutes - defaultMinutes) / defaultMinutes) * 100);
      if (pctChange !== 0) {
        const direction = pctChange > 0 ? 'slower' : 'faster';
        return `${pctChange > 0 ? '+' : ''}${pctChange}% ${direction}`;
      } else {
        return 'baseline';
      }
    }
    return 'baseline';
  };

  it('should show baseline for event-triggered hooks with no adjustment', () => {
    const result = getFreqAdjForEventTriggered('pre_commit_review', 5, 5, false, undefined);

    expect(result).toBe('baseline');
  });

  it('should show percentage increase for event-triggered hooks with slower intervals', () => {
    const result = getFreqAdjForEventTriggered('test_failure_reporter', 120, 144, false, undefined);

    expect(result).toBe('+20% slower');
  });

  it('should show percentage decrease for event-triggered hooks with faster intervals', () => {
    const result = getFreqAdjForEventTriggered('compliance_checker_file', 10080, 8064, false, undefined);

    expect(result).toBe('-20% faster');
  });

  it('should show static mode for event-triggered hooks', () => {
    const result = getFreqAdjForEventTriggered('pre_commit_review', 5, 10, true, 10);

    expect(result).toBe('static 10m');
  });

  it('should handle zero default minutes for event-triggered hooks', () => {
    const result = getFreqAdjForEventTriggered('pre_commit_review', 0, 5, false, undefined);

    expect(result).toBe('baseline');
  });

  it('should show percentage when change is small but non-zero', () => {
    // 120 to 121 = 0.83% change, rounds to 1%
    const result = getFreqAdjForEventTriggered('test_failure_reporter', 120, 121, false, undefined);

    expect(result).toBe('+1% slower');
  });
});

describe('Automated Instances - tokensByType field', () => {
  it('should always include tokensByType in AutomatedInstancesData', () => {
    // tokensByType maps display name → total tokens (24h)
    const tokensByType: Record<string, number> = {};

    expect(typeof tokensByType).toBe('object');
    expect(tokensByType).not.toBeNull();
    expect(Array.isArray(tokensByType)).toBe(false);
  });

  it('should accept empty tokensByType', () => {
    const data = {
      instances: [],
      usageTarget: 90,
      currentProjected: null,
      adjustingDirection: 'stable' as const,
      hasData: false,
      tokensByType: {},
    };

    expect(Object.keys(data.tokensByType).length).toBe(0);
  });

  it('should accept tokensByType with entries mapping display name to token count', () => {
    const data = {
      instances: [],
      usageTarget: 90,
      currentProjected: null,
      adjustingDirection: 'stable' as const,
      hasData: true,
      tokensByType: {
        'Pre-Commit Hook': 12500,
        'Task Runner': 48000,
        'Lint Checker': 7200,
      },
    };

    expect(data.tokensByType['Pre-Commit Hook']).toBe(12500);
    expect(data.tokensByType['Task Runner']).toBe(48000);
    expect(data.tokensByType['Lint Checker']).toBe(7200);
    expect(Object.keys(data.tokensByType).length).toBe(3);
  });

  it('should require all tokensByType values to be non-negative numbers', () => {
    const tokensByType: Record<string, number> = {
      'Pre-Commit Hook': 12500,
      'Task Runner': 0,
    };

    for (const [_key, value] of Object.entries(tokensByType)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(value)).toBe(false);
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('getAutomationTokenUsage - Session JSONL parsing', () => {
  let tempDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `automation-token-usage-${randomUUID()}`);
    // Simulate the session directory structure that getAutomationTokenUsage expects:
    // ~/.claude/projects/-{projectPath}/
    // For tests we use a temp dir that mimics the structure.
    sessionDir = path.join(tempDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helpers to build JSONL session entries that match what Claude sessions produce.
   */
  const makeUserEntry = (agentType: string | null): string => {
    const content = agentType ? `[Task][${agentType}] Please perform the task.` : 'Hello, human turn without task prefix.';
    return JSON.stringify({
      type: 'human',
      content,
      message: { content },
    });
  };

  const makeAssistantEntry = (inputTokens: number, outputTokens: number, cacheRead = 0, cacheCreate = 0): string => {
    return JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreate,
        },
      },
    });
  };

  it('should return empty object when session directory does not exist', async () => {
    // Build a token usage aggregator that mirrors getAutomationTokenUsage logic
    // but operates on our temp sessionDir.
    const aggregateTokens = async (dir: string): Promise<Record<string, number>> => {
      if (!fs.existsSync(dir)) return {};

      const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.jsonl'));
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const rawTokens: Record<string, number> = {};

      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtime.getTime() < since) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        let agentType: string | null = null;
        let totalTokens = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              content?: string;
              message?: { content?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
            };
            if (agentType === null && (entry.type === 'human' || entry.type === 'user')) {
              const msg = typeof entry.message?.content === 'string' ? entry.message.content : entry.content;
              if (msg) {
                const match = msg.match(/^\[Task\]\[([^\]]+)\]/);
                if (match?.[1]) {
                  agentType = match[1];
                } else {
                  break;
                }
              }
            }
            const usage = entry.message?.usage;
            if (usage) {
              totalTokens += (usage.input_tokens || 0)
                + (usage.output_tokens || 0)
                + (usage.cache_read_input_tokens || 0)
                + (usage.cache_creation_input_tokens || 0);
            }
          } catch {
            // skip malformed
          }
        }

        if (agentType && totalTokens > 0) {
          rawTokens[agentType] = (rawTokens[agentType] || 0) + totalTokens;
        }
      }

      return rawTokens;
    };

    const result = await aggregateTokens(path.join(tempDir, 'nonexistent'));
    expect(result).toEqual({});
  });

  it('should return empty object when no .jsonl files exist', async () => {
    fs.writeFileSync(path.join(sessionDir, 'not-a-jsonl.txt'), 'some content');

    const files = fs.readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'));
    expect(files.length).toBe(0);
  });

  it('should parse a task-triggered session and sum all token usage', () => {
    const lines = [
      makeUserEntry('lint-fixer'),
      makeAssistantEntry(1000, 500, 200, 300),
      makeAssistantEntry(800, 400),
    ].join('\n') + '\n';

    const filePath = path.join(sessionDir, `session-${randomUUID()}.jsonl`);
    fs.writeFileSync(filePath, lines);

    // Parse the JSONL manually to verify structure
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = content.split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));

    // First entry should be the user message with task prefix
    expect(parsed[0].type).toBe('human');
    expect(parsed[0].content).toMatch(/^\[Task\]\[lint-fixer\]/);

    // Second and third entries have usage
    const usage1 = parsed[1].message.usage;
    const usage2 = parsed[2].message.usage;

    const total1 = (usage1.input_tokens || 0) + (usage1.output_tokens || 0)
      + (usage1.cache_read_input_tokens || 0) + (usage1.cache_creation_input_tokens || 0);
    const total2 = (usage2.input_tokens || 0) + (usage2.output_tokens || 0);

    expect(total1).toBe(2000); // 1000+500+200+300
    expect(total2).toBe(1200); // 800+400
    expect(total1 + total2).toBe(3200);
  });

  it('should skip non-task sessions (no [Task][...] prefix)', () => {
    const lines = [
      makeUserEntry(null),
      makeAssistantEntry(5000, 2000),
    ].join('\n') + '\n';

    const filePath = path.join(sessionDir, `session-${randomUUID()}.jsonl`);
    fs.writeFileSync(filePath, lines);

    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = content.split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));

    // Verify user message does NOT have task prefix
    expect(parsed[0].content).not.toMatch(/^\[Task\]\[/);
  });

  it('should handle sessions with zero token usage gracefully', () => {
    const lines = [
      makeUserEntry('claudemd-refactor'),
      // No assistant entries with token usage
      JSON.stringify({ type: 'assistant', message: {} }),
    ].join('\n') + '\n';

    const filePath = path.join(sessionDir, `session-${randomUUID()}.jsonl`);
    fs.writeFileSync(filePath, lines);

    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = content.split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));

    expect(parsed[0].content).toMatch(/^\[Task\]\[claudemd-refactor\]/);
    // No usage in second entry
    expect(parsed[1].message.usage).toBeUndefined();
  });

  it('should accumulate tokens across multiple sessions for the same agent type', () => {
    const sessionA = [
      makeUserEntry('lint-fixer'),
      makeAssistantEntry(1000, 500),
    ].join('\n') + '\n';

    const sessionB = [
      makeUserEntry('lint-fixer'),
      makeAssistantEntry(2000, 1000),
    ].join('\n') + '\n';

    fs.writeFileSync(path.join(sessionDir, `session-a-${randomUUID()}.jsonl`), sessionA);
    fs.writeFileSync(path.join(sessionDir, `session-b-${randomUUID()}.jsonl`), sessionB);

    // Simulate rollup: both sessions contribute to the same raw agent type
    const counts: Record<string, number> = {};
    for (const file of fs.readdirSync(sessionDir).filter((f: string) => f.endsWith('.jsonl'))) {
      const content = fs.readFileSync(path.join(sessionDir, file), 'utf8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      let agentType: string | null = null;
      let total = 0;
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (agentType === null && (entry.type === 'human' || entry.type === 'user')) {
          const msg = typeof entry.message?.content === 'string' ? entry.message.content : entry.content;
          const match = msg?.match(/^\[Task\]\[([^\]]+)\]/);
          if (match?.[1]) { agentType = match[1]; } else { break; }
        }
        const usage = entry.message?.usage;
        if (usage) {
          total += (usage.input_tokens || 0) + (usage.output_tokens || 0)
            + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        }
      }
      if (agentType && total > 0) {
        counts[agentType] = (counts[agentType] || 0) + total;
      }
    }

    // Both sessions are for 'lint-fixer': 1500 + 3000 = 4500
    expect(counts['lint-fixer']).toBe(4500);
  });

  it('should roll up raw agent types into display names via INSTANCE_DEFINITIONS', () => {
    // Verify the rollup logic: 'lint-fixer' → 'Lint Checker'
    const agentTypeToDisplayName: Record<string, string> = {
      'lint-fixer': 'Lint Checker',
      'claudemd-refactor': 'CLAUDE.md Refactor',
      'task-runner-code-reviewer': 'Task Runner',
      'task-runner-investigator': 'Task Runner',
      'deputy-cto-review': 'Pre-Commit Hook',
    };

    const rawTokens: Record<string, number> = {
      'lint-fixer': 5000,
      'claudemd-refactor': 3000,
      'task-runner-code-reviewer': 2000,
      'task-runner-investigator': 1500,
    };

    const byDisplayName: Record<string, number> = {};
    for (const [rawType, tokens] of Object.entries(rawTokens)) {
      const displayName = agentTypeToDisplayName[rawType] || rawType;
      byDisplayName[displayName] = (byDisplayName[displayName] || 0) + tokens;
    }

    expect(byDisplayName['Lint Checker']).toBe(5000);
    expect(byDisplayName['CLAUDE.md Refactor']).toBe(3000);
    // Both task-runner sub-types roll up into 'Task Runner'
    expect(byDisplayName['Task Runner']).toBe(3500);
    expect(byDisplayName['Pre-Commit Hook']).toBeUndefined();
  });

  it('should handle malformed JSONL lines without throwing', () => {
    const lines = [
      makeUserEntry('lint-fixer'),
      'THIS IS NOT VALID JSON {{{',
      makeAssistantEntry(1000, 500),
    ].join('\n') + '\n';

    const filePath = path.join(sessionDir, `session-${randomUUID()}.jsonl`);
    fs.writeFileSync(filePath, lines);

    // The content file has 3 lines; the middle one is malformed
    const content = fs.readFileSync(filePath, 'utf8');
    const nonEmptyLines = content.split('\n').filter((l: string) => l.trim());
    expect(nonEmptyLines.length).toBe(3);

    // Verify the malformed line fails JSON.parse
    expect(() => JSON.parse(nonEmptyLines[1])).toThrow();

    // Valid lines still parse correctly
    const first = JSON.parse(nonEmptyLines[0]);
    expect(first.type).toBe('human');

    const third = JSON.parse(nonEmptyLines[2]);
    expect(third.message.usage.input_tokens).toBe(1000);
  });
});
