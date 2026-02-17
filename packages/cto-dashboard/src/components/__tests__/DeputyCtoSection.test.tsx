/**
 * Unit tests for DeputyCtoSection component
 *
 * Tests rendering behavior for the Deputy CTO triage pipeline dashboard:
 * - Summary metrics (untriaged, escalated, pending questions, 24h counts)
 * - Untriaged reports table
 * - Escalated reports table
 * - Pending questions list
 * - Recently triaged reports (24h history)
 * - Answered questions (24h history)
 * - Conditional rendering based on data availability
 * - Empty state handling
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { DeputyCtoSection } from '../DeputyCtoSection.js';
import type { DeputyCtoData } from '../../utils/deputy-cto-reader.js';

describe('DeputyCtoSection', () => {
  describe('Empty State', () => {
    it('should return null when hasData is false', () => {
      const emptyData: DeputyCtoData = {
        hasData: false,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={emptyData} />);
      expect(lastFrame()).toBe('');
    });

    it('should not render subsections when all arrays are empty', () => {
      const emptyData: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 5,
        escalated24h: 2,
        dismissed24h: 1,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={emptyData} />);
      const output = lastFrame();

      // Should render summary metrics but not subsections
      expect(output).toBeTruthy();
      expect(output).not.toContain('UNTRIAGED');
      expect(output).not.toContain('ESCALATED');
      expect(output).not.toContain('PENDING QUESTIONS');
      expect(output).not.toContain('Recently Triaged');
      expect(output).not.toContain('Answered Questions');
    });
  });

  describe('Summary Metrics', () => {
    it('should render all summary metric boxes', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 5,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 12,
        escalated24h: 2,
        dismissed24h: 3,
        pendingQuestions: [],
        pendingQuestionCount: 4,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Untriaged');
      expect(output).toContain('5');
      expect(output).toContain('Escalated');
      expect(output).toContain('0'); // escalated.length
      expect(output).toContain('Pending Q');
      expect(output).toContain('4');
      expect(output).toContain('24h Handled');
      expect(output).toContain('12');
      expect(output).toContain('24h Dismissed');
      expect(output).toContain('3');
    });

    it('should display zero counts correctly', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Untriaged');
      expect(output).toContain('0');
      expect(output).toBeTruthy();
    });
  });

  describe('Untriaged Reports', () => {
    it('should render untriaged reports table', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [
          {
            id: 'r1',
            title: 'Critical bug in auth module',
            priority: 'high',
            triage_status: 'pending',
            triage_outcome: null,
            created_at: new Date('2026-02-16T10:00:00').toISOString(),
            triage_completed_at: null,
          },
          {
            id: 'r2',
            title: 'Performance regression detected',
            priority: 'medium',
            triage_status: 'pending',
            triage_outcome: null,
            created_at: new Date('2026-02-16T09:30:00').toISOString(),
            triage_completed_at: null,
          },
        ],
        untriagedCount: 2,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('UNTRIAGED');
      expect(output).toContain('(2)');
      expect(output).toContain('Critical bug in auth module');
      expect(output).toContain('Performance regression detected');
      expect(output).toContain('high');
      expect(output).toContain('medium');
      expect(output).toContain('Title');
      expect(output).toContain('Priority');
      expect(output).toContain('Time');
    });

    it('should handle empty untriaged list', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 5,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('UNTRIAGED');
    });

    it('should truncate long report titles', () => {
      const longTitle = 'A'.repeat(100);
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [
          {
            id: 'r1',
            title: longTitle,
            priority: 'low',
            triage_status: 'pending',
            triage_outcome: null,
            created_at: new Date('2026-02-16T10:00:00').toISOString(),
            triage_completed_at: null,
          },
        ],
        untriagedCount: 1,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      // Title should be truncated - verify partial content and ellipsis
      expect(output).toContain('AAA');
      expect(output).toContain('\u2026'); // Contains truncation ellipsis
      expect(output).toBeTruthy();
      // Output should not contain the full untruncated title
      const consecutiveAs = output!.match(/A+/g);
      const longestASequence = consecutiveAs ? Math.max(...consecutiveAs.map(s => s.length)) : 0;
      expect(longestASequence).toBeLessThan(longTitle.length);
    });
  });

  describe('Escalated Reports', () => {
    it('should render escalated reports table', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [
          {
            id: 'e1',
            title: 'Security vulnerability CVE-2024-1234',
            priority: 'critical',
            triage_status: 'escalated',
            triage_outcome: 'needs_review',
            created_at: new Date('2026-02-15T14:00:00').toISOString(),
            triage_completed_at: new Date('2026-02-15T15:00:00').toISOString(),
          },
        ],
        selfHandled24h: 0,
        escalated24h: 1,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('ESCALATED');
      // Title is truncated due to COL_TITLE = 35
      expect(output).toContain('Security vulnerability CVE-2024-');
      expect(output).toContain('critical');
    });

    it('should handle empty escalated list', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 5,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('ESCALATED');
    });
  });

  describe('Pending Questions', () => {
    it('should render pending questions list', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [
          {
            id: 'q1',
            type: 'decision',
            title: 'Should we migrate to new framework?',
            description: 'Current framework is deprecated',
            recommendation: null,
            created_at: new Date('2026-02-16T08:00:00').toISOString(),
          },
          {
            id: 'q2',
            type: 'clarification',
            title: 'What is the target deployment date?',
            description: 'Need to plan sprint',
            recommendation: null,
            created_at: new Date('2026-02-16T07:30:00').toISOString(),
          },
        ],
        pendingQuestionCount: 2,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('PENDING QUESTIONS');
      expect(output).toContain('(2)');
      // Titles are truncated due to COL_TITLE = 35
      expect(output).toContain('Should we migrate to new framewo');
      expect(output).toContain('What is the target deployment da');
      expect(output).toContain('decision');
      // "clarification" may wrap due to column width - check for partial match
      expect(output).toContain('clarifi');
    });

    it('should render recommendation subtitle when provided', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [
          {
            id: 'q1',
            type: 'decision',
            title: 'Should we migrate to new framework?',
            description: 'Current framework is deprecated',
            recommendation: 'Recommend migration to React 19 - breaking changes are minimal',
            created_at: new Date('2026-02-16T08:00:00').toISOString(),
          },
        ],
        pendingQuestionCount: 1,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('PENDING QUESTIONS');
      // Title is truncated due to COL_TITLE = 35
      expect(output).toContain('Should we migrate to new framewo');
      expect(output).toContain('Recommend migration to React 19');
      // Verify tree connector is present
      expect(output).toContain('\u2514\u2500');
    });

    it('should not render recommendation subtitle when null', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [
          {
            id: 'q1',
            type: 'decision',
            title: 'Question without recommendation',
            description: 'Description',
            recommendation: null,
            created_at: new Date('2026-02-16T08:00:00').toISOString(),
          },
        ],
        pendingQuestionCount: 1,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Question without recommendation');
      // Should not contain tree connector since no recommendation
      const lines = output!.split('\n');
      const questionLine = lines.find((line) => line.includes('Question without recommendation'));
      const questionLineIndex = lines.indexOf(questionLine!);
      const nextLine = lines[questionLineIndex + 1];
      // Next line should not contain tree connector
      expect(nextLine).not.toContain('\u2514\u2500');
    });

    it('should truncate very long recommendations', () => {
      const longRecommendation = 'A'.repeat(200);
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [
          {
            id: 'q1',
            type: 'decision',
            title: 'Question with long recommendation',
            description: 'Description',
            recommendation: longRecommendation,
            created_at: new Date('2026-02-16T08:00:00').toISOString(),
          },
        ],
        pendingQuestionCount: 1,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Question with long recommendation');
      expect(output).toContain('AAA');
      expect(output).toContain('\u2026'); // Truncation ellipsis
      // Verify full recommendation is not displayed
      const consecutiveAs = output!.match(/A+/g);
      const longestASequence = consecutiveAs ? Math.max(...consecutiveAs.map((s) => s.length)) : 0;
      expect(longestASequence).toBeLessThan(longRecommendation.length);
    });

    it('should handle empty pending questions list', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 5,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('PENDING QUESTIONS');
    });
  });

  describe('Recently Triaged Reports', () => {
    it('should render recently triaged reports with outcomes', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [
          {
            id: 'rt1',
            title: 'Fixed typo in documentation',
            priority: 'low',
            triage_status: 'self_handled',
            triage_outcome: 'fixed',
            created_at: new Date('2026-02-16T09:00:00').toISOString(),
            triage_completed_at: new Date('2026-02-16T10:00:00').toISOString(),
          },
          {
            id: 'rt2',
            title: 'Duplicate bug report',
            priority: 'medium',
            triage_status: 'dismissed',
            triage_outcome: 'duplicate',
            created_at: new Date('2026-02-16T08:00:00').toISOString(),
            triage_completed_at: new Date('2026-02-16T09:30:00').toISOString(),
          },
        ],
        escalated: [],
        selfHandled24h: 1,
        escalated24h: 0,
        dismissed24h: 1,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Recently Triaged');
      expect(output).toContain('Fixed typo in documentation');
      expect(output).toContain('Duplicate bug report');
      expect(output).toContain('Outcome'); // Outcome column header
      expect(output).toContain('Handled');
      expect(output).toContain('Dismissed');
    });

    it('should handle empty recently triaged list', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('Recently Triaged');
    });
  });

  describe('Answered Questions', () => {
    it('should render answered questions list', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [
          {
            id: 'aq1',
            title: 'Approved migration to TypeScript 5.3',
            answer: 'Yes, proceed with migration',
            answered_at: new Date('2026-02-16T11:00:00').toISOString(),
            decided_by: 'cto',
          },
          {
            id: 'aq2',
            title: 'Deployment scheduled for next week',
            answer: null,
            answered_at: new Date('2026-02-16T10:30:00').toISOString(),
            decided_by: null,
          },
        ],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Answered Questions');
      // Titles are truncated due to COL_TITLE = 35
      expect(output).toContain('Approved migration to TypeScript');
      expect(output).toContain('Deployment scheduled for next we');
      // Answer truncated due to COL_ANSWER = 26
      expect(output).toContain('Yes, proceed with migra');
    });

    it('should handle null answer field', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [
          {
            id: 'aq1',
            title: 'Question without answer text',
            answer: null,
            answered_at: new Date('2026-02-16T11:00:00').toISOString(),
            decided_by: null,
          },
        ],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Answered Questions');
      expect(output).toContain('Question without answer text');
      expect(output).toContain('-'); // Null answer should display as '-'
    });

    it('should handle empty answered questions list', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).not.toContain('Answered Questions');
    });
  });

  describe('Complete Dashboard', () => {
    it('should render all sections when data is available', () => {
      const completeData: DeputyCtoData = {
        hasData: true,
        untriaged: [
          {
            id: 'u1',
            title: 'Untriaged report',
            priority: 'high',
            triage_status: 'pending',
            triage_outcome: null,
            created_at: new Date('2026-02-16T10:00:00').toISOString(),
            triage_completed_at: null,
          },
        ],
        untriagedCount: 1,
        recentlyTriaged: [
          {
            id: 'rt1',
            title: 'Recently triaged report',
            priority: 'medium',
            triage_status: 'self_handled',
            triage_outcome: 'fixed',
            created_at: new Date('2026-02-16T09:00:00').toISOString(),
            triage_completed_at: new Date('2026-02-16T10:00:00').toISOString(),
          },
        ],
        escalated: [
          {
            id: 'e1',
            title: 'Escalated report',
            priority: 'critical',
            triage_status: 'escalated',
            triage_outcome: 'needs_review',
            created_at: new Date('2026-02-15T14:00:00').toISOString(),
            triage_completed_at: new Date('2026-02-15T15:00:00').toISOString(),
          },
        ],
        selfHandled24h: 5,
        escalated24h: 1,
        dismissed24h: 2,
        pendingQuestions: [
          {
            id: 'q1',
            type: 'decision',
            title: 'Pending question',
            description: 'Description',
            recommendation: null,
            created_at: new Date('2026-02-16T08:00:00').toISOString(),
          },
        ],
        pendingQuestionCount: 1,
        answeredQuestions: [
          {
            id: 'aq1',
            title: 'Answered question',
            answer: 'Answer text',
            answered_at: new Date('2026-02-16T11:00:00').toISOString(),
            decided_by: 'cto',
          },
        ],
      };

      const { lastFrame } = render(<DeputyCtoSection data={completeData} />);
      const output = lastFrame();

      // Summary metrics
      expect(output).toContain('Untriaged');
      expect(output).toContain('1');
      expect(output).toContain('24h Handled');
      expect(output).toContain('5');

      // Action items
      expect(output).toContain('UNTRIAGED');
      expect(output).toContain('Untriaged report');
      expect(output).toContain('ESCALATED');
      expect(output).toContain('Escalated report');
      expect(output).toContain('PENDING QUESTIONS');
      expect(output).toContain('Pending question');

      // History
      expect(output).toContain('Recently Triaged');
      expect(output).toContain('Recently triaged report');
      expect(output).toContain('Answered Questions');
      expect(output).toContain('Answered question');
    });
  });

  describe('Priority Color Mapping', () => {
    it('should render all priority levels without errors', () => {
      const priorities = ['critical', 'high', 'medium', 'low', 'normal'];

      priorities.forEach((priority) => {
        const data: DeputyCtoData = {
          hasData: true,
          untriaged: [
            {
              id: 'r1',
              title: 'Test report',
              priority,
              triage_status: 'pending',
              triage_outcome: null,
              created_at: new Date('2026-02-16T10:00:00').toISOString(),
              triage_completed_at: null,
            },
          ],
          untriagedCount: 1,
          recentlyTriaged: [],
          escalated: [],
          selfHandled24h: 0,
          escalated24h: 0,
          dismissed24h: 0,
          pendingQuestions: [],
          pendingQuestionCount: 0,
          answeredQuestions: [],
        };

        const { lastFrame } = render(<DeputyCtoSection data={data} />);
        const output = lastFrame();

        expect(output).toContain('Test report');
        expect(output).toContain(priority);
      });
    });

    it('should handle undefined priority', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [
          {
            id: 'r1',
            title: 'Test report',
            priority: '',
            triage_status: 'pending',
            triage_outcome: null,
            created_at: new Date('2026-02-16T10:00:00').toISOString(),
            triage_completed_at: null,
          },
        ],
        untriagedCount: 1,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Test report');
      expect(output).toContain('-'); // Empty priority should show as '-'
    });
  });

  describe('Component Structure Validation', () => {
    it('should return a React element when hasData is true', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 0,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const result = render(<DeputyCtoSection data={data} />);

      expect(result).toBeDefined();
      expect(result.lastFrame()).toBeTruthy();
    });

    it('should maintain consistent structure across renders', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 5,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 3,
        escalated24h: 0,
        dismissed24h: 1,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const render1 = render(<DeputyCtoSection data={data} />);
      const render2 = render(<DeputyCtoSection data={data} />);

      expect(render1.lastFrame()).toBe(render2.lastFrame());
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters in titles', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [
          {
            id: 'r1',
            title: 'Test <>&"\' special chars',
            priority: 'medium',
            triage_status: 'pending',
            triage_outcome: null,
            created_at: new Date('2026-02-16T10:00:00').toISOString(),
            triage_completed_at: null,
          },
        ],
        untriagedCount: 1,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('Test <>&"\' special chars');
    });

    it('should handle very large counts', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [],
        untriagedCount: 999999,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 1000000,
        escalated24h: 500000,
        dismissed24h: 250000,
        pendingQuestions: [],
        pendingQuestionCount: 123456,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      expect(output).toContain('999999');
      expect(output).toContain('1000000');
      expect(output).toContain('123456');
    });

    it('should handle empty strings in fields', () => {
      const data: DeputyCtoData = {
        hasData: true,
        untriaged: [
          {
            id: '',
            title: '',
            priority: '',
            triage_status: 'pending',
            triage_outcome: null,
            created_at: new Date('2026-02-16T10:00:00').toISOString(),
            triage_completed_at: null,
          },
        ],
        untriagedCount: 1,
        recentlyTriaged: [],
        escalated: [],
        selfHandled24h: 0,
        escalated24h: 0,
        dismissed24h: 0,
        pendingQuestions: [],
        pendingQuestionCount: 0,
        answeredQuestions: [],
      };

      const { lastFrame } = render(<DeputyCtoSection data={data} />);
      const output = lastFrame();

      // Should not crash with empty strings
      expect(output).toBeTruthy();
      expect(output).toContain('UNTRIAGED');
    });
  });
});
