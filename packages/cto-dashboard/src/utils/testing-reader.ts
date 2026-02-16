/**
 * Testing Data Reader
 *
 * Reads test failure state, agent-tracker test activity, and optionally
 * Codecov coverage data for the Testing dashboard section.
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');

// Test failure state can be at project root or workspace level
const TEST_FAILURE_STATE_PATHS = [
  path.join(PROJECT_DIR, '.claude', 'test-failure-state.json'),
  path.join(PROJECT_DIR, '.claude', 'state', 'test-failure-state.json'),
];

const TEST_AGENT_TYPES = [
  'test-failure-jest',
  'test-failure-vitest',
  'test-failure-playwright',
  'task-runner-test-writer',
];

// ============================================================================
// Types
// ============================================================================

export interface FailingSuite {
  name: string;
  since: string;  // ISO timestamp
}

export interface TestingData {
  hasData: boolean;
  failingSuites: FailingSuite[];
  testAgentSpawns24h: number;
  // 7-day test failure agent activity (daily counts for sparkline)
  dailyTestActivity: number[];
  // Codecov (optional)
  codecov: {
    coveragePercent: number;
    trend: number[];  // 7 values for sparkline
  } | null;
}

interface AgentHistoryEntry {
  type: string;
  timestamp: string;
}

interface AgentHistory {
  agents: AgentHistoryEntry[];
}

interface TestFailureState {
  suites?: Record<string, string>;
  failureHashes?: Record<string, string>;
}

// ============================================================================
// Main
// ============================================================================

export function getTestingData(): TestingData {
  const result: TestingData = {
    hasData: false,
    failingSuites: [],
    testAgentSpawns24h: 0,
    dailyTestActivity: [],
    codecov: null,
  };

  // Read test failure state files
  for (const statePath of TEST_FAILURE_STATE_PATHS) {
    if (!fs.existsSync(statePath)) continue;

    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as TestFailureState;
      if (state.suites) {
        for (const [name, since] of Object.entries(state.suites)) {
          // Avoid duplicates if both paths point to the same file
          if (!result.failingSuites.some(s => s.name === name)) {
            result.failingSuites.push({ name, since });
          }
        }
      }
      result.hasData = true;
    } catch {
      // Ignore corrupted files
    }
  }

  // Also check workspace-level test failure state (monorepo pattern)
  try {
    const workspaceDirs = findWorkspaceTestStates();
    for (const wsPath of workspaceDirs) {
      try {
        const state = JSON.parse(fs.readFileSync(wsPath, 'utf8')) as TestFailureState;
        if (state.suites) {
          for (const [name, since] of Object.entries(state.suites)) {
            if (!result.failingSuites.some(s => s.name === name)) {
              result.failingSuites.push({ name, since });
            }
          }
        }
        result.hasData = true;
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }

  // Sort failing suites by most recent first
  result.failingSuites.sort((a, b) => b.since.localeCompare(a.since));

  // Read agent tracker for test-related activity
  if (fs.existsSync(AGENT_TRACKER_PATH)) {
    try {
      const content = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
      const history = JSON.parse(content) as AgentHistory;

      const now = Date.now();
      const cutoff24h = now - 24 * 60 * 60 * 1000;
      const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;

      // Buckets for 7-day sparkline (index 0 = 7 days ago, index 6 = today)
      const dailyCounts = new Array(7).fill(0);

      for (const agent of history.agents || []) {
        if (!TEST_AGENT_TYPES.includes(agent.type)) continue;

        const agentTime = new Date(agent.timestamp).getTime();
        if (agentTime >= cutoff24h) {
          result.testAgentSpawns24h++;
        }
        if (agentTime >= cutoff7d) {
          const daysAgo = Math.floor((now - agentTime) / (24 * 60 * 60 * 1000));
          const bucketIdx = 6 - Math.min(daysAgo, 6);
          dailyCounts[bucketIdx]++;
        }
      }

      result.dailyTestActivity = dailyCounts;
      result.hasData = true;
    } catch {
      // Ignore
    }
  }

  return result;
}

/**
 * Fetch Codecov coverage data (optional, async).
 * Returns null if CODECOV_TOKEN is not set or request fails.
 */
export async function getCodecovData(): Promise<{ coveragePercent: number; trend: number[] } | null> {
  const token = process.env['CODECOV_TOKEN'];
  const owner = process.env['CODECOV_OWNER'];
  const repo = process.env['CODECOV_REPO'];
  if (!token || !owner || !repo) return null;

  const service = process.env['CODECOV_SERVICE'] || 'github';
  const baseUrl = 'https://api.codecov.io/api/v2';
  const headers = { Authorization: `bearer ${token}`, Accept: 'application/json' };

  try {
    // Get current coverage
    const coverageResp = await fetch(`${baseUrl}/${service}/${owner}/repos/${repo}/totals/`, { headers });
    if (!coverageResp.ok) return null;
    const coverageData = await coverageResp.json() as Record<string, unknown>;
    const totals = coverageData.totals as Record<string, unknown> | undefined;
    const coveragePercent = typeof totals?.coverage === 'number' ? totals.coverage : 0;

    // Get 7-day trend
    let trend: number[] = [];
    try {
      const trendResp = await fetch(`${baseUrl}/${service}/${owner}/repos/${repo}/coverage/?interval=1d`, { headers });
      if (trendResp.ok) {
        const trendData = await trendResp.json() as Record<string, unknown>;
        const results = trendData.results as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(results)) {
          trend = results.slice(-7).map(d => (typeof d.coverage === 'number' ? d.coverage : 0));
        }
      }
    } catch {
      // Trend is optional
    }

    return { coveragePercent, trend };
  } catch {
    return null;
  }
}

/**
 * Find workspace-level test-failure-state.json files in common monorepo patterns.
 */
function findWorkspaceTestStates(): string[] {
  const results: string[] = [];
  const patterns = ['products', 'packages', 'apps'];

  for (const dir of patterns) {
    const base = path.join(PROJECT_DIR, dir);
    if (!fs.existsSync(base)) continue;

    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Check direct .claude/test-failure-state.json
        const stateFile = path.join(base, entry.name, '.claude', 'test-failure-state.json');
        if (fs.existsSync(stateFile)) {
          results.push(stateFile);
        }

        // Check nested apps/web/.claude/test-failure-state.json
        const appsDir = path.join(base, entry.name, 'apps');
        if (fs.existsSync(appsDir)) {
          try {
            const appEntries = fs.readdirSync(appsDir, { withFileTypes: true });
            for (const appEntry of appEntries) {
              if (!appEntry.isDirectory()) continue;
              const nestedState = path.join(appsDir, appEntry.name, '.claude', 'test-failure-state.json');
              if (fs.existsSync(nestedState)) {
                results.push(nestedState);
              }
            }
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  return results;
}
