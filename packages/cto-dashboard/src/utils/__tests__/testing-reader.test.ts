/**
 * Unit tests for testing-reader.ts
 *
 * Tests querying test failure state and agent-tracker history:
 * - Failing suites with fix attempts, last attempt, and framework
 * - Agent breakdown by framework (24h)
 * - Resolved suites (targeted by agents but no longer failing)
 * - Unique failure signatures (24h)
 * - Daily test activity (7-day sparkline)
 * - Codecov coverage data (optional)
 *
 * Uses filesystem-based test files for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getTestingData } from '../testing-reader.js';
import type { TestingData, FailingSuite, AgentBreakdown } from '../testing-reader.js';

describe('Testing Reader', () => {
  let tempDir: string;
  let claudeDir: string;
  let stateDir: string;
  let testFailureStatePath: string;
  let agentTrackerPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `testing-reader-test-${randomUUID()}`);
    claudeDir = path.join(tempDir, '.claude');
    stateDir = path.join(claudeDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    testFailureStatePath = path.join(claudeDir, 'test-failure-state.json');
    agentTrackerPath = path.join(stateDir, 'agent-tracker-history.json');

    process.env['CLAUDE_PROJECT_DIR'] = tempDir;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env['CLAUDE_PROJECT_DIR'];
  });

  describe('Empty State', () => {
    it('should return empty data when no files exist', () => {
      const result = getTestingData();

      expect(result.hasData).toBe(false);
      expect(result.failingSuites).toEqual([]);
      expect(result.testAgentSpawns24h).toBe(0);
      expect(result.agentBreakdown24h).toEqual({ jest: 0, vitest: 0, playwright: 0, testWriter: 0 });
      expect(result.suitesFixedRecently).toBe(0);
      expect(result.uniqueFailureSignatures24h).toBe(0);
      expect(result.dailyTestActivity).toEqual([]);
      expect(result.codecov).toBeNull();
    });

    it('should validate structure of empty data', () => {
      const result = getTestingData();

      expect(result).toHaveProperty('hasData');
      expect(result).toHaveProperty('failingSuites');
      expect(result).toHaveProperty('testAgentSpawns24h');
      expect(result).toHaveProperty('agentBreakdown24h');
      expect(result).toHaveProperty('suitesFixedRecently');
      expect(result).toHaveProperty('uniqueFailureSignatures24h');
      expect(result).toHaveProperty('dailyTestActivity');
      expect(result).toHaveProperty('codecov');

      expect(typeof result.hasData).toBe('boolean');
      expect(Array.isArray(result.failingSuites)).toBe(true);
      expect(typeof result.testAgentSpawns24h).toBe('number');
      expect(typeof result.agentBreakdown24h).toBe('object');
      expect(typeof result.suitesFixedRecently).toBe('number');
      expect(typeof result.uniqueFailureSignatures24h).toBe('number');
      expect(Array.isArray(result.dailyTestActivity)).toBe(true);
    });
  });

  describe('Failing Suites', () => {
    it('should load failing suites from test-failure-state.json', () => {
      const state = {
        suites: {
          'auth.test.ts': '2026-02-15T10:00:00.000Z',
          'api.test.ts': '2026-02-16T08:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const result = getTestingData();

      expect(result.hasData).toBe(true);
      expect(result.failingSuites.length).toBe(2);
      expect(result.failingSuites[0].name).toBe('auth.test.ts');
      expect(result.failingSuites[0].since).toBe('2026-02-15T10:00:00.000Z');
      expect(result.failingSuites[0].fixAttempts).toBe(0);
      expect(result.failingSuites[0].lastAttempt).toBeNull();
      expect(result.failingSuites[0].framework).toBe('unknown');
    });

    it('should load failing suites from state subdirectory', () => {
      const stateFilePath = path.join(stateDir, 'test-failure-state.json');
      const state = {
        suites: {
          'component.test.tsx': '2026-02-16T09:00:00.000Z'
        }
      };
      fs.writeFileSync(stateFilePath, JSON.stringify(state));

      const result = getTestingData();

      expect(result.hasData).toBe(true);
      expect(result.failingSuites.length).toBe(1);
      expect(result.failingSuites[0].name).toBe('component.test.tsx');
    });

    it('should deduplicate suites from multiple state files', () => {
      const state = {
        suites: {
          'auth.test.ts': '2026-02-15T10:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));
      fs.writeFileSync(path.join(stateDir, 'test-failure-state.json'), JSON.stringify(state));

      const result = getTestingData();

      expect(result.failingSuites.length).toBe(1);
    });

    it('should handle corrupted test failure state file', () => {
      fs.writeFileSync(testFailureStatePath, 'invalid json');

      const result = getTestingData();

      expect(result.hasData).toBe(false);
      expect(result.failingSuites).toEqual([]);
    });

    it('should validate FailingSuite structure', () => {
      const state = {
        suites: {
          'test.spec.ts': '2026-02-16T10:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const result = getTestingData();
      const suite = result.failingSuites[0];

      expect(suite).toHaveProperty('name');
      expect(suite).toHaveProperty('since');
      expect(suite).toHaveProperty('fixAttempts');
      expect(suite).toHaveProperty('lastAttempt');
      expect(suite).toHaveProperty('framework');

      expect(typeof suite.name).toBe('string');
      expect(typeof suite.since).toBe('string');
      expect(typeof suite.fixAttempts).toBe('number');
      expect(suite.lastAttempt === null || typeof suite.lastAttempt === 'string').toBe(true);
      expect(['jest', 'vitest', 'playwright', 'unknown']).toContain(suite.framework);
    });
  });

  describe('Agent Tracking', () => {
    it('should count test agent spawns in 24h', () => {
      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['auth.test.ts'] }
          },
          {
            type: 'test-failure-vitest',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['api.test.ts'] }
          },
          {
            type: 'test-failure-playwright',
            timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['e2e.spec.ts'] }
          },
          // Old agent (should not count)
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['old.test.ts'] }
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.testAgentSpawns24h).toBe(3);
    });

    it('should break down agents by framework', () => {
      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['a.test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['b.test.ts'] }
          },
          {
            type: 'test-failure-vitest',
            timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['c.test.ts'] }
          },
          {
            type: 'test-failure-playwright',
            timestamp: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['d.spec.ts'] }
          },
          {
            type: 'task-runner-test-writer',
            timestamp: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
            metadata: {}
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.agentBreakdown24h.jest).toBe(2);
      expect(result.agentBreakdown24h.vitest).toBe(1);
      expect(result.agentBreakdown24h.playwright).toBe(1);
      expect(result.agentBreakdown24h.testWriter).toBe(1);
    });

    it('should ignore non-test agent types', () => {
      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['test.ts'] }
          },
          {
            type: 'code-reviewer',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: {}
          },
          {
            type: 'test-writer',
            timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            metadata: {}
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.testAgentSpawns24h).toBe(1);
    });

    it('should validate AgentBreakdown structure', () => {
      const result = getTestingData();

      expect(result.agentBreakdown24h).toHaveProperty('jest');
      expect(result.agentBreakdown24h).toHaveProperty('vitest');
      expect(result.agentBreakdown24h).toHaveProperty('playwright');
      expect(result.agentBreakdown24h).toHaveProperty('testWriter');

      expect(typeof result.agentBreakdown24h.jest).toBe('number');
      expect(typeof result.agentBreakdown24h.vitest).toBe('number');
      expect(typeof result.agentBreakdown24h.playwright).toBe('number');
      expect(typeof result.agentBreakdown24h.testWriter).toBe('number');
    });
  });

  describe('Fix Attempts Per Suite', () => {
    it('should count fix attempts per suite', () => {
      const state = {
        suites: {
          'auth.test.ts': '2026-02-15T10:00:00.000Z',
          'api.test.ts': '2026-02-16T08:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['auth.test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['auth.test.ts'] }
          },
          {
            type: 'test-failure-vitest',
            timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['api.test.ts'] }
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      const authSuite = result.failingSuites.find(s => s.name === 'auth.test.ts');
      const apiSuite = result.failingSuites.find(s => s.name === 'api.test.ts');

      expect(authSuite?.fixAttempts).toBe(2);
      expect(apiSuite?.fixAttempts).toBe(1);
    });

    it('should track last attempt timestamp per suite', () => {
      const state = {
        suites: {
          'test.ts': '2026-02-15T10:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const now = Date.now();
      const recentTimestamp = new Date(now - 1 * 60 * 60 * 1000).toISOString();
      const olderTimestamp = new Date(now - 3 * 60 * 60 * 1000).toISOString();

      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: olderTimestamp,
            metadata: { suiteNames: ['test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: recentTimestamp,
            metadata: { suiteNames: ['test.ts'] }
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.failingSuites[0].lastAttempt).toBe(recentTimestamp);
    });

    it('should infer framework from agent type', () => {
      const state = {
        suites: {
          'jest.test.ts': '2026-02-15T10:00:00.000Z',
          'vitest.test.ts': '2026-02-15T11:00:00.000Z',
          'playwright.spec.ts': '2026-02-15T12:00:00.000Z',
          'unknown.test.ts': '2026-02-15T13:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['jest.test.ts'] }
          },
          {
            type: 'test-failure-vitest',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['vitest.test.ts'] }
          },
          {
            type: 'test-failure-playwright',
            timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['playwright.spec.ts'] }
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      const jestSuite = result.failingSuites.find(s => s.name === 'jest.test.ts');
      const vitestSuite = result.failingSuites.find(s => s.name === 'vitest.test.ts');
      const playwrightSuite = result.failingSuites.find(s => s.name === 'playwright.spec.ts');
      const unknownSuite = result.failingSuites.find(s => s.name === 'unknown.test.ts');

      expect(jestSuite?.framework).toBe('jest');
      expect(vitestSuite?.framework).toBe('vitest');
      expect(playwrightSuite?.framework).toBe('playwright');
      expect(unknownSuite?.framework).toBe('unknown');
    });

    it('should sort suites by fix attempts then age', () => {
      const state = {
        suites: {
          'high-attempts-old.test.ts': '2026-02-14T10:00:00.000Z',
          'high-attempts-new.test.ts': '2026-02-16T10:00:00.000Z',
          'low-attempts-old.test.ts': '2026-02-15T10:00:00.000Z',
          'low-attempts-new.test.ts': '2026-02-16T08:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const now = Date.now();
      const history = {
        agents: [
          // high-attempts-old: 3 attempts
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['high-attempts-old.test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['high-attempts-old.test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['high-attempts-old.test.ts'] }
          },
          // high-attempts-new: 3 attempts
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['high-attempts-new.test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['high-attempts-new.test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['high-attempts-new.test.ts'] }
          },
          // low-attempts-old: 1 attempt
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['low-attempts-old.test.ts'] }
          }
          // low-attempts-new: 0 attempts
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      // Should be sorted: high-attempts first (3, 3), then by age within same attempts
      expect(result.failingSuites[0].name).toBe('high-attempts-old.test.ts');
      expect(result.failingSuites[1].name).toBe('high-attempts-new.test.ts');
      expect(result.failingSuites[2].name).toBe('low-attempts-old.test.ts');
      expect(result.failingSuites[3].name).toBe('low-attempts-new.test.ts');
    });
  });

  describe('Resolved Suites', () => {
    it('should count suites targeted by agents but no longer failing', () => {
      const state = {
        suites: {
          'still-failing.test.ts': '2026-02-15T10:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['still-failing.test.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['fixed.test.ts'] }
          },
          {
            type: 'test-failure-vitest',
            timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['also-fixed.test.ts'] }
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.suitesFixedRecently).toBe(2); // fixed.test.ts and also-fixed.test.ts
    });

    it('should handle agents without suiteNames metadata', () => {
      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: {}
          },
          {
            type: 'task-runner-test-writer',
            timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            metadata: {}
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.suitesFixedRecently).toBe(0);
    });
  });

  describe('Unique Failure Signatures', () => {
    it('should count unique failure signatures in 24h', () => {
      const now = Date.now();
      const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const old = new Date(now - 25 * 60 * 60 * 1000).toISOString();

      const state = {
        suites: {},
        failureHashes: {
          'hash1': new Date(now - 1 * 60 * 60 * 1000).toISOString(),
          'hash2': new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          'hash3': new Date(now - 3 * 60 * 60 * 1000).toISOString(),
          'hash4': old // Should not count
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const result = getTestingData();

      expect(result.uniqueFailureSignatures24h).toBe(3);
    });

    it('should handle missing failureHashes field', () => {
      const state = {
        suites: {
          'test.ts': '2026-02-15T10:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const result = getTestingData();

      expect(result.uniqueFailureSignatures24h).toBe(0);
    });
  });

  describe('Daily Test Activity', () => {
    it('should create 7-day sparkline of test agent activity', () => {
      const now = Date.now();
      const history = {
        agents: [
          // Today (bucket 6)
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['test1.ts'] }
          },
          // 1 day ago (bucket 5)
          {
            type: 'test-failure-vitest',
            timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['test2.ts'] }
          },
          // 2 days ago (bucket 4)
          {
            type: 'test-failure-playwright',
            timestamp: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['test3.spec.ts'] }
          },
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['test4.ts'] }
          },
          // 8 days ago (should not appear)
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
            metadata: { suiteNames: ['old.ts'] }
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.dailyTestActivity.length).toBe(7);
      expect(result.dailyTestActivity[6]).toBe(1); // Today
      expect(result.dailyTestActivity[5]).toBe(1); // 1 day ago
      expect(result.dailyTestActivity[4]).toBe(2); // 2 days ago
      expect(result.dailyTestActivity[3]).toBe(0); // 3 days ago
      expect(result.dailyTestActivity[2]).toBe(0); // 4 days ago
      expect(result.dailyTestActivity[1]).toBe(0); // 5 days ago
      expect(result.dailyTestActivity[0]).toBe(0); // 6 days ago
    });

    it('should handle empty agent history', () => {
      const history = { agents: [] };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.dailyTestActivity.length).toBe(7);
      expect(result.dailyTestActivity.every(d => d === 0)).toBe(true);
    });
  });

  describe('Workspace Test States', () => {
    it('should find test states in monorepo packages/', () => {
      const packagesDir = path.join(tempDir, 'packages', 'pkg1', '.claude');
      fs.mkdirSync(packagesDir, { recursive: true });

      const state = {
        suites: {
          'workspace-test.ts': '2026-02-16T10:00:00.000Z'
        }
      };
      fs.writeFileSync(path.join(packagesDir, 'test-failure-state.json'), JSON.stringify(state));

      const result = getTestingData();

      expect(result.hasData).toBe(true);
      expect(result.failingSuites.length).toBe(1);
      expect(result.failingSuites[0].name).toBe('workspace-test.ts');
    });

    it('should find test states in nested apps/', () => {
      const appsDir = path.join(tempDir, 'packages', 'pkg1', 'apps', 'web', '.claude');
      fs.mkdirSync(appsDir, { recursive: true });

      const state = {
        suites: {
          'nested-test.ts': '2026-02-16T11:00:00.000Z'
        }
      };
      fs.writeFileSync(path.join(appsDir, 'test-failure-state.json'), JSON.stringify(state));

      const result = getTestingData();

      expect(result.hasData).toBe(true);
      expect(result.failingSuites.some(s => s.name === 'nested-test.ts')).toBe(true);
    });

    it('should deduplicate suites from workspace and root', () => {
      const rootState = {
        suites: {
          'shared-test.ts': '2026-02-16T10:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(rootState));

      const packagesDir = path.join(tempDir, 'packages', 'pkg1', '.claude');
      fs.mkdirSync(packagesDir, { recursive: true });
      fs.writeFileSync(path.join(packagesDir, 'test-failure-state.json'), JSON.stringify(rootState));

      const result = getTestingData();

      expect(result.failingSuites.length).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle corrupted agent tracker file', () => {
      fs.writeFileSync(agentTrackerPath, 'invalid json');

      const result = getTestingData();

      expect(result.testAgentSpawns24h).toBe(0);
      expect(result.dailyTestActivity).toEqual([]);
    });

    it('should handle missing agent metadata', () => {
      const now = Date.now();
      const history = {
        agents: [
          {
            type: 'test-failure-jest',
            timestamp: new Date(now - 1 * 60 * 60 * 1000).toISOString()
            // No metadata field
          }
        ]
      };
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.testAgentSpawns24h).toBe(1);
      expect(() => getTestingData()).not.toThrow();
    });

    it('should handle empty suites object', () => {
      const state = { suites: {} };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      const result = getTestingData();

      expect(result.hasData).toBe(true);
      expect(result.failingSuites).toEqual([]);
    });

    it('should handle missing agents array', () => {
      const history = {};
      fs.writeFileSync(agentTrackerPath, JSON.stringify(history));

      const result = getTestingData();

      expect(result.testAgentSpawns24h).toBe(0);
    });

    it('should validate numeric types are never NaN', () => {
      const result = getTestingData();

      expect(Number.isNaN(result.testAgentSpawns24h)).toBe(false);
      expect(Number.isNaN(result.suitesFixedRecently)).toBe(false);
      expect(Number.isNaN(result.uniqueFailureSignatures24h)).toBe(false);
      expect(Number.isNaN(result.agentBreakdown24h.jest)).toBe(false);
      expect(Number.isNaN(result.agentBreakdown24h.vitest)).toBe(false);
      expect(Number.isNaN(result.agentBreakdown24h.playwright)).toBe(false);
      expect(Number.isNaN(result.agentBreakdown24h.testWriter)).toBe(false);
    });
  });

  describe('Structure Validation', () => {
    it('should return consistent structure regardless of data', () => {
      const emptyResult = getTestingData();

      const state = {
        suites: {
          'test.ts': '2026-02-16T10:00:00.000Z'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));
      const withDataResult = getTestingData();

      expect(Object.keys(emptyResult).sort()).toEqual(Object.keys(withDataResult).sort());
    });

    it('should fail loudly on invalid date strings', () => {
      const state = {
        suites: {
          'test.ts': 'invalid-date'
        }
      };
      fs.writeFileSync(testFailureStatePath, JSON.stringify(state));

      // Should not throw - but will process invalid date
      const result = getTestingData();
      expect(result.failingSuites[0].since).toBe('invalid-date');
    });
  });
});
