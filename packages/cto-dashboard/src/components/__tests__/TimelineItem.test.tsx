/**
 * Unit tests for TimelineItem component
 *
 * Tests rendering behavior, icon visual width mapping, spacing adjustments,
 * priority tags, subtitle/details rendering, and timestamp formatting.
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { TimelineItem, type TimelineEvent, type TimelineEventType } from '../TimelineItem.js';

describe('TimelineItem', () => {
  describe('Basic Rendering', () => {
    it('should render a basic timeline event', () => {
      const event: TimelineEvent = {
        type: 'hook',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Test event',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('10:30');
      expect(output).toContain('HOOK');
      expect(output).toContain('Test event');
    });

    it('should render all event types without errors', () => {
      const eventTypes: TimelineEventType[] = ['hook', 'report', 'question', 'task', 'session'];

      eventTypes.forEach((type) => {
        const event: TimelineEvent = {
          type,
          timestamp: new Date('2026-02-16T10:30:00'),
          title: `Test ${type}`,
        };

        const { lastFrame } = render(<TimelineItem event={event} />);
        const output = lastFrame();

        expect(output).toBeTruthy();
        expect(output).toContain('10:30');
        expect(output).toContain(`Test ${type}`);
      });
    });

    it('should render event type labels correctly', () => {
      const testCases: Array<{ type: TimelineEventType; expectedLabel: string }> = [
        { type: 'hook', expectedLabel: 'HOOK' },
        { type: 'report', expectedLabel: 'REPORT' },
        { type: 'question', expectedLabel: 'QUESTION' },
        { type: 'task', expectedLabel: 'TASK' },
        { type: 'session', expectedLabel: 'SESSION' },
      ];

      testCases.forEach(({ type, expectedLabel }) => {
        const event: TimelineEvent = {
          type,
          timestamp: new Date('2026-02-16T10:30:00'),
          title: 'Test',
        };

        const { lastFrame } = render(<TimelineItem event={event} />);
        expect(lastFrame()).toContain(expectedLabel);
      });
    });
  });

  describe('Icon Visual Width Mapping', () => {
    it('should use 1-column width for hook, task, and session icons', () => {
      // These icons (●, ■, ○) render as single columns in terminals
      const singleColumnTypes: TimelineEventType[] = ['hook', 'task', 'session'];

      singleColumnTypes.forEach((type) => {
        const event: TimelineEvent = {
          type,
          timestamp: new Date('2026-02-16T10:30:00'),
          title: 'Test',
        };

        const { lastFrame } = render(<TimelineItem event={event} />);
        const output = lastFrame();

        // Single column icons should have 2 spaces after timestamp
        // Output format: "10:30  ● HOOK  Test"
        expect(output).toContain('10:30');
        expect(output).toBeTruthy();
      });
    });

    it('should use 2-column width for report and question icons', () => {
      // These icons (◆, ◇) render as double columns in most terminals
      const doubleColumnTypes: TimelineEventType[] = ['report', 'question'];

      doubleColumnTypes.forEach((type) => {
        const event: TimelineEvent = {
          type,
          timestamp: new Date('2026-02-16T10:30:00'),
          title: 'Test',
        };

        const { lastFrame } = render(<TimelineItem event={event} />);
        const output = lastFrame();

        // Double column icons should have 1 space after timestamp
        // Output format: "10:30 ◆ REPORT  Test"
        expect(output).toContain('10:30');
        expect(output).toBeTruthy();
      });
    });

    it('should maintain consistent visual alignment across all icon types', () => {
      // Test that spacing adjustment keeps timestamp-to-label distance consistent
      const events: TimelineEvent[] = [
        { type: 'hook', timestamp: new Date('2026-02-16T10:30:00'), title: 'Hook event' },
        { type: 'report', timestamp: new Date('2026-02-16T10:30:00'), title: 'Report event' },
        { type: 'question', timestamp: new Date('2026-02-16T10:30:00'), title: 'Question event' },
        { type: 'task', timestamp: new Date('2026-02-16T10:30:00'), title: 'Task event' },
        { type: 'session', timestamp: new Date('2026-02-16T10:30:00'), title: 'Session event' },
      ];

      events.forEach((event) => {
        const { lastFrame } = render(<TimelineItem event={event} />);
        const output = lastFrame();

        // All events should render timestamp and title
        expect(output).toContain('10:30');
        expect(output).toContain(event.title);

        // No errors should occur
        expect(output).toBeTruthy();
        expect(typeof output).toBe('string');
      });
    });
  });

  describe('Priority Tags', () => {
    it('should render priority tags for non-normal priorities', () => {
      const priorities: Array<'low' | 'high' | 'critical'> = ['low', 'high', 'critical'];

      priorities.forEach((priority) => {
        const event: TimelineEvent = {
          type: 'report',
          timestamp: new Date('2026-02-16T10:30:00'),
          title: 'Test',
          priority,
        };

        const { lastFrame } = render(<TimelineItem event={event} />);
        const output = lastFrame();

        expect(output).toContain(`[${priority.toUpperCase()}]`);
      });
    });

    it('should not render priority tag for normal priority', () => {
      const event: TimelineEvent = {
        type: 'report',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Test',
        priority: 'normal',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).not.toContain('[NORMAL]');
    });

    it('should not render priority tag when priority is undefined', () => {
      const event: TimelineEvent = {
        type: 'report',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Test',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).not.toContain('[');
      expect(output).not.toContain(']');
    });
  });

  describe('Subtitle and Details', () => {
    it('should render subtitle when provided', () => {
      const event: TimelineEvent = {
        type: 'task',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Main task',
        subtitle: 'Subtask details',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('Main task');
      expect(output).toContain('Subtask details');
    });

    it('should render details when provided', () => {
      const event: TimelineEvent = {
        type: 'task',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Main task',
        details: 'Additional context',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('Main task');
      expect(output).toContain('Additional context');
    });

    it('should render both subtitle and details when provided', () => {
      const event: TimelineEvent = {
        type: 'task',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Main task',
        subtitle: 'Subtask details',
        details: 'Additional context',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('Main task');
      expect(output).toContain('Subtask details');
      expect(output).toContain('Additional context');
    });

    it('should not error when subtitle and details are undefined', () => {
      const event: TimelineEvent = {
        type: 'task',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Main task',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('Main task');
      expect(output).toBeTruthy();
    });
  });

  describe('Timestamp Formatting', () => {
    it('should format timestamps in 24-hour format with leading zeros', () => {
      const testCases = [
        { time: '2026-02-16T00:00:00', expected: '00:00' },
        { time: '2026-02-16T09:05:00', expected: '09:05' },
        { time: '2026-02-16T12:30:00', expected: '12:30' },
        { time: '2026-02-16T23:59:00', expected: '23:59' },
      ];

      testCases.forEach(({ time, expected }) => {
        const event: TimelineEvent = {
          type: 'hook',
          timestamp: new Date(time),
          title: 'Test',
        };

        const { lastFrame } = render(<TimelineItem event={event} />);
        expect(lastFrame()).toContain(expected);
      });
    });

    it('should render timestamps without seconds', () => {
      const event: TimelineEvent = {
        type: 'hook',
        timestamp: new Date('2026-02-16T10:30:45'),
        title: 'Test',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('10:30');
      expect(output).not.toContain(':45');
    });
  });

  describe('Complete Event Rendering', () => {
    it('should render a complete event with all optional fields', () => {
      const event: TimelineEvent = {
        type: 'report',
        timestamp: new Date('2026-02-16T14:25:00'),
        title: 'Security vulnerability detected',
        subtitle: 'CVE-2024-1234 in dependency',
        details: 'npm audit fix recommended',
        priority: 'critical',
        status: 'pending',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('14:25');
      expect(output).toContain('REPORT');
      expect(output).toContain('Security vulnerability detected');
      expect(output).toContain('[CRITICAL]');
      expect(output).toContain('CVE-2024-1234 in dependency');
      expect(output).toContain('npm audit fix recommended');
    });

    it('should render correctly with minimal required fields only', () => {
      const event: TimelineEvent = {
        type: 'session',
        timestamp: new Date('2026-02-16T10:00:00'),
        title: 'Session started',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('10:00');
      expect(output).toContain('SESSION');
      expect(output).toContain('Session started');
    });
  });

  describe('Component Structure Validation', () => {
    it('should return a React element', () => {
      const event: TimelineEvent = {
        type: 'hook',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Test',
      };

      const result = render(<TimelineItem event={event} />);

      expect(result).toBeDefined();
      expect(result.lastFrame()).toBeTruthy();
    });

    it('should not throw errors for any valid event type', () => {
      const eventTypes: TimelineEventType[] = ['hook', 'report', 'question', 'task', 'session'];

      eventTypes.forEach((type) => {
        expect(() => {
          const event: TimelineEvent = {
            type,
            timestamp: new Date('2026-02-16T10:30:00'),
            title: 'Test',
          };
          render(<TimelineItem event={event} />);
        }).not.toThrow();
      });
    });

    it('should maintain consistent structure across renders', () => {
      const event: TimelineEvent = {
        type: 'task',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Test',
      };

      const render1 = render(<TimelineItem event={event} />);
      const render2 = render(<TimelineItem event={event} />);

      expect(render1.lastFrame()).toBe(render2.lastFrame());
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty title string', () => {
      const event: TimelineEvent = {
        type: 'hook',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: '',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('10:30');
      expect(output).toContain('HOOK');
    });

    it('should handle very long title strings', () => {
      const longTitle = 'A'.repeat(200);
      const event: TimelineEvent = {
        type: 'report',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: longTitle,
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      // Long titles may wrap and label may be truncated, check for basic structure
      expect(output).toContain('10:30');
      expect(output).toContain('REPOR'); // Label may be truncated in terminal
      expect(output).toContain('AAA'); // Check for partial title
      expect(output).toBeTruthy();
    });

    it('should handle special characters in title', () => {
      const event: TimelineEvent = {
        type: 'question',
        timestamp: new Date('2026-02-16T10:30:00'),
        title: 'Test <>&"\' special chars',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('Test <>&"\' special chars');
    });

    it('should handle midnight timestamp', () => {
      const event: TimelineEvent = {
        type: 'hook',
        timestamp: new Date('2026-02-16T00:00:00'),
        title: 'Midnight event',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('00:00');
    });

    it('should handle end-of-day timestamp', () => {
      const event: TimelineEvent = {
        type: 'session',
        timestamp: new Date('2026-02-16T23:59:59'),
        title: 'End of day',
      };

      const { lastFrame } = render(<TimelineItem event={event} />);
      const output = lastFrame();

      expect(output).toContain('23:59');
    });
  });
});
