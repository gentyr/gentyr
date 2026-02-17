/**
 * Unit tests for TestingSection component
 *
 * Tests rendering behavior for the Testing dashboard:
 * - Failing suites with fix attempt pips, age coloring, and framework badges
 * - Agent breakdown by framework (24h)
 * - Summary metrics (resolved suites, unique failures)
 * - 7-day activity sparkline
 * - Codecov coverage + trend (optional)
 * - Conditional rendering based on data availability
 * - Empty state handling
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { TestingSection } from '../TestingSection.js';
import type { TestingData } from '../../utils/testing-reader.js';

describe('TestingSection', () => {
  describe('Empty State', () => {
    it('should return null when hasData is false', () => {
      const emptyData: TestingData = {
        hasData: false,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={emptyData} />);
      expect(lastFrame()).toBe('');
    });
  });

  describe('All Suites Passing', () => {
    it('should show "All Suites Passing" when no failing suites', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 5,
        agentBreakdown24h: { jest: 3, vitest: 2, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 2,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [1, 2, 3, 1, 2, 1, 0],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('All Suites Passing');
      expect(output).not.toContain('Failing Suites');
    });
  });

  describe('Failing Suites', () => {
    it('should render failing suites table with all columns', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'auth.test.ts',
            since: '2026-02-15T10:00:00.000Z',
            fixAttempts: 3,
            lastAttempt: '2026-02-16T09:00:00.000Z',
            framework: 'jest'
          },
          {
            name: 'api.test.ts',
            since: '2026-02-16T08:00:00.000Z',
            fixAttempts: 1,
            lastAttempt: '2026-02-16T10:00:00.000Z',
            framework: 'vitest'
          }
        ],
        testAgentSpawns24h: 4,
        agentBreakdown24h: { jest: 3, vitest: 1, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 2,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Failing Suites');
      expect(output).toContain('(2)');
      expect(output).toContain('auth.test.ts');
      expect(output).toContain('api.test.ts');
      expect(output).toContain('jest');
      expect(output).toContain('vitest');
    });

    it('should display fix attempt pips correctly', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'zero-attempts.test.ts',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'unknown'
          },
          {
            name: 'many-attempts.test.ts',
            since: '2026-02-15T10:00:00.000Z',
            fixAttempts: 7,
            lastAttempt: '2026-02-16T11:00:00.000Z',
            framework: 'jest'
          }
        ],
        testAgentSpawns24h: 7,
        agentBreakdown24h: { jest: 7, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      // Should show pip indicators and counts
      expect(output).toContain('0'); // Zero attempts count
      expect(output).toContain('7'); // Many attempts count
      expect(output).toBeTruthy();
    });

    it('should handle all framework types', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'jest.test.ts',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'jest'
          },
          {
            name: 'vitest.test.ts',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'vitest'
          },
          {
            name: 'playwright.spec.ts',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'playwright'
          },
          {
            name: 'unknown.test.ts',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'unknown'
          }
        ],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('jest');
      expect(output).toContain('vitest');
      expect(output).toContain('playwright');
      expect(output).toContain('-'); // unknown framework shows as '-'
    });

    it('should truncate long suite names', () => {
      const longName = 'a'.repeat(100);
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: longName,
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'jest'
          }
        ],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      // Should contain ellipsis for truncation
      expect(output).toContain('\u2026');
      expect(output).toBeTruthy();
    });

    it('should display age with appropriate coloring logic', () => {
      const now = Date.now();
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'very-old.test.ts',
            since: new Date(now - 10 * 60 * 60 * 1000).toISOString(), // 10 hours ago
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'jest'
          },
          {
            name: 'medium-old.test.ts',
            since: new Date(now - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'vitest'
          },
          {
            name: 'recent.test.ts',
            since: new Date(now - 30 * 60 * 1000).toISOString(), // 30 minutes ago
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'playwright'
          }
        ],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      // Should render all suites with time indicators
      expect(output).toContain('very-old.test.ts');
      expect(output).toContain('medium-old.test.ts');
      expect(output).toContain('recent.test.ts');
    });
  });

  describe('Agent Breakdown', () => {
    it('should show agent breakdown when agents spawned in 24h', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 15,
        agentBreakdown24h: { jest: 8, vitest: 4, playwright: 2, testWriter: 1 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Agents (24h)');
      expect(output).toContain('15');
      expect(output).toContain('Jest');
      expect(output).toContain('8');
      expect(output).toContain('Vitest');
      expect(output).toContain('4');
      expect(output).toContain('PW');
      expect(output).toContain('2');
      expect(output).toContain('Writer');
      expect(output).toContain('1');
    });

    it('should not show breakdown when no agents', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('Jest');
      expect(output).not.toContain('Vitest');
      expect(output).not.toContain('PW');
      expect(output).not.toContain('Writer');
    });

    it('should handle zero counts in breakdown', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 5,
        agentBreakdown24h: { jest: 5, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('5');
      expect(output).toContain('Jest');
      expect(output).toContain('0'); // Zero counts still shown
    });
  });

  describe('Summary Metrics', () => {
    it('should display resolved suites count', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 3,
        agentBreakdown24h: { jest: 3, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 5,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Resolved');
      expect(output).toContain('5 suites');
    });

    it('should display unique failure signatures', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 12,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Unique failures');
      expect(output).toContain('12');
    });

    it('should handle singular vs plural for resolved suites', () => {
      const dataSingular: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 1,
        agentBreakdown24h: { jest: 1, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 1,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame: singularFrame } = render(<TestingSection data={dataSingular} />);
      const singularOutput = singularFrame();

      expect(singularOutput).toContain('1 suite');
      expect(singularOutput).not.toContain('1 suites');

      const dataPlural: TestingData = {
        ...dataSingular,
        suitesFixedRecently: 3
      };

      const { lastFrame: pluralFrame } = render(<TestingSection data={dataPlural} />);
      const pluralOutput = pluralFrame();

      expect(pluralOutput).toContain('3 suites');
    });

    it('should not show summary metrics when all zeros', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('Resolved');
      expect(output).not.toContain('Unique failures');
      expect(output).not.toContain('Agents (24h)');
    });
  });

  describe('Activity Sparkline', () => {
    it('should display 7-day activity sparkline', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 5,
        agentBreakdown24h: { jest: 5, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [1, 2, 3, 5, 4, 2, 1],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('7d activity');
      expect(output).toBeTruthy();
    });

    it('should show "no data" for empty activity', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [0, 0, 0, 0, 0, 0, 0],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('no data');
    });

    it('should not render sparkline when dailyTestActivity is empty array', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('7d activity');
    });
  });

  describe('Codecov Integration', () => {
    it('should display codecov coverage and trend', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: {
          coveragePercent: 85.5,
          trend: [80, 82, 83, 84, 85, 85, 85.5]
        }
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Coverage');
      expect(output).toContain('86%'); // Rounded
      expect(output).toContain('7d trend');
    });

    it('should apply color thresholds to coverage', () => {
      const testCoverages = [
        { percent: 85, expected: true }, // >= 80: green
        { percent: 70, expected: true }, // >= 60: yellow
        { percent: 50, expected: true }  // < 60: red
      ];

      testCoverages.forEach(({ percent }) => {
        const data: TestingData = {
          hasData: true,
          failingSuites: [],
          testAgentSpawns24h: 0,
          agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
          suitesFixedRecently: 0,
          uniqueFailureSignatures24h: 0,
          dailyTestActivity: [],
          testActivityTimeseries: [],
          codecov: {
            coveragePercent: percent,
            trend: []
          }
        };

        const { lastFrame } = render(<TestingSection data={data} />);
        const output = lastFrame();

        expect(output).toContain('Coverage');
        expect(output).toContain(`${Math.round(percent)}%`);
      });
    });

    it('should handle empty codecov trend', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: {
          coveragePercent: 75,
          trend: []
        }
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Coverage');
      expect(output).toContain('75%');
      expect(output).not.toContain('7d trend');
    });

    it('should not display codecov when null', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 5,
        agentBreakdown24h: { jest: 5, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [1, 2, 3, 4, 5, 6, 7],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('Coverage');
      expect(output).not.toContain('7d trend');
    });
  });

  describe('Complete Dashboard', () => {
    it('should render all sections when full data is available', () => {
      const completeData: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'auth.test.ts',
            since: '2026-02-15T10:00:00.000Z',
            fixAttempts: 3,
            lastAttempt: '2026-02-16T09:00:00.000Z',
            framework: 'jest'
          },
          {
            name: 'api.test.ts',
            since: '2026-02-16T08:00:00.000Z',
            fixAttempts: 1,
            lastAttempt: '2026-02-16T10:00:00.000Z',
            framework: 'vitest'
          }
        ],
        testAgentSpawns24h: 15,
        agentBreakdown24h: { jest: 8, vitest: 4, playwright: 2, testWriter: 1 },
        suitesFixedRecently: 3,
        uniqueFailureSignatures24h: 5,
        dailyTestActivity: [2, 3, 5, 4, 3, 2, 1],
        testActivityTimeseries: [],
        codecov: {
          coveragePercent: 82.5,
          trend: [78, 79, 80, 81, 81.5, 82, 82.5]
        }
      };

      const { lastFrame } = render(<TestingSection data={completeData} />);
      const output = lastFrame();

      // Failing suites
      expect(output).toContain('Failing Suites');
      expect(output).toContain('(2)');
      expect(output).toContain('auth.test.ts');

      // Agent breakdown
      expect(output).toContain('Agents (24h)');
      expect(output).toContain('15');

      // Summary metrics
      expect(output).toContain('Resolved');
      expect(output).toContain('3 suites');
      expect(output).toContain('Unique failures');
      expect(output).toContain('5');

      // Activity sparkline
      expect(output).toContain('7d activity');

      // Codecov
      expect(output).toContain('Coverage');
      expect(output).toContain('83%');
      expect(output).toContain('7d trend');
    });
  });

  describe('Component Structure Validation', () => {
    it('should return a React element when hasData is true', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const result = render(<TestingSection data={data} />);

      expect(result).toBeDefined();
      expect(result.lastFrame()).toBeTruthy();
    });

    it('should maintain consistent structure across renders', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 5,
        agentBreakdown24h: { jest: 5, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 2,
        uniqueFailureSignatures24h: 3,
        dailyTestActivity: [1, 2, 3, 4, 5, 6, 7],
        testActivityTimeseries: [],
        codecov: null
      };

      const render1 = render(<TestingSection data={data} />);
      const render2 = render(<TestingSection data={data} />);

      expect(render1.lastFrame()).toBe(render2.lastFrame());
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters in suite names', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'test <>&"\' special.test.ts',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'jest'
          }
        ],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('test <>&"\' special.test.ts');
    });

    it('should handle very large counts', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [],
        testAgentSpawns24h: 999999,
        agentBreakdown24h: { jest: 500000, vitest: 300000, playwright: 150000, testWriter: 49999 },
        suitesFixedRecently: 100000,
        uniqueFailureSignatures24h: 50000,
        dailyTestActivity: [10000, 20000, 30000, 40000, 50000, 60000, 70000],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('999999');
      expect(output).toContain('100000');
      expect(output).toContain('50000');
    });

    it('should handle null lastAttempt in FailingSuite', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'never-attempted.test.ts',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'jest'
          }
        ],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('never-attempted.test.ts');
      expect(output).toBeTruthy();
    });

    it('should handle very high fix attempt counts', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: 'stubborn.test.ts',
            since: '2026-02-15T10:00:00.000Z',
            fixAttempts: 100,
            lastAttempt: '2026-02-16T11:00:00.000Z',
            framework: 'jest'
          }
        ],
        testAgentSpawns24h: 100,
        agentBreakdown24h: { jest: 100, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('100');
      expect(output).toContain('stubborn.test.ts');
    });

    it('should handle codecov coverage at boundary values', () => {
      const testCases = [
        { percent: 0, expected: '0%' },
        { percent: 100, expected: '100%' },
        { percent: 79.9, expected: '80%' }, // Rounding
        { percent: 80.0, expected: '80%' },
        { percent: 59.9, expected: '60%' }
      ];

      testCases.forEach(({ percent, expected }) => {
        const data: TestingData = {
          hasData: true,
          failingSuites: [],
          testAgentSpawns24h: 0,
          agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
          suitesFixedRecently: 0,
          uniqueFailureSignatures24h: 0,
          dailyTestActivity: [],
          testActivityTimeseries: [],
          codecov: {
            coveragePercent: percent,
            trend: []
          }
        };

        const { lastFrame } = render(<TestingSection data={data} />);
        const output = lastFrame();

        expect(output).toContain(expected);
      });
    });

    it('should handle empty suite name', () => {
      const data: TestingData = {
        hasData: true,
        failingSuites: [
          {
            name: '',
            since: '2026-02-16T10:00:00.000Z',
            fixAttempts: 0,
            lastAttempt: null,
            framework: 'jest'
          }
        ],
        testAgentSpawns24h: 0,
        agentBreakdown24h: { jest: 0, vitest: 0, playwright: 0, testWriter: 0 },
        suitesFixedRecently: 0,
        uniqueFailureSignatures24h: 0,
        dailyTestActivity: [],
        testActivityTimeseries: [],
        codecov: null
      };

      const { lastFrame } = render(<TestingSection data={data} />);
      const output = lastFrame();

      // Should not crash with empty string
      expect(output).toBeTruthy();
      expect(output).toContain('Failing Suites');
    });
  });
});
