/**
 * Unit tests for UsageTrajectory component
 *
 * Tests rendering behavior for usage trajectory projections:
 * - Side-by-side 5-hour and 7-day window cards
 * - Current usage, projected usage, reset time, trend display
 * - Conditional rendering based on data availability
 * - Empty state handling
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { UsageTrajectory } from '../UsageTrajectory.js';
import type { TrajectoryResult } from '../../utils/trajectory.js';

describe('UsageTrajectory', () => {
  describe('Empty State', () => {
    it('should return null when hasData is false', () => {
      const emptyTrajectory: TrajectoryResult = {
        snapshots: [],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: false,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={emptyTrajectory} />);
      expect(lastFrame()).toBe('');
    });

    it('should return null when snapshots array is empty', () => {
      const emptyTrajectory: TrajectoryResult = {
        snapshots: [],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={emptyTrajectory} />);
      expect(lastFrame()).toBe('');
    });
  });

  describe('Basic Rendering - Window Cards', () => {
    it('should render 5-hour and 7-day window cards', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('5-Hour Window');
      expect(output).toContain('7-Day Window');
      expect(output).toContain('USAGE TRAJECTORY');
    });

    it('should display current usage values', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('Current:');
      expect(output).toContain('45%'); // Current 5h
      expect(output).toContain('65%'); // Current 7d
    });

    it('should display reset time when available', () => {
      const now = new Date();
      const resetTime5h = new Date(now.getTime() + 101 * 60 * 1000); // 101 minutes
      const resetTime7d = new Date(now.getTime() + 111 * 60 * 60 * 1000); // 111 hours

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: resetTime5h,
        sevenDayResetTime: resetTime7d,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('Reset In:');
      // Should show time in h/m or d/h format
      expect(output).toMatch(/\d+h/);
    });

    it('should display N/A for missing reset time', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('Reset In:');
      expect(output).toContain('N/A');
    });

    it('should display projected values when available', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 85,
        fiveHourResetTime: new Date(now.getTime() + 3600000),
        sevenDayResetTime: new Date(now.getTime() + 86400000),
        fiveHourTrendPerHour: 2.5,
        sevenDayTrendPerDay: 0.5,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('At Reset:');
      expect(output).toContain('70%'); // Projected 5h
      expect(output).toContain('85%'); // Projected 7d
    });

    it('should display N/A for missing projections', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('At Reset:');
      const naMatches = output?.match(/N\/A/g);
      expect(naMatches).toBeTruthy();
      expect(naMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it('should display trend information when available', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 85,
        fiveHourResetTime: new Date(now.getTime() + 3600000),
        sevenDayResetTime: new Date(now.getTime() + 86400000),
        fiveHourTrendPerHour: 2.5,
        sevenDayTrendPerDay: 0.5,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('Trend:');
      expect(output).toContain('2.5%/hr'); // 5h trend
      expect(output).toContain('0.5%/day'); // 7d trend
    });

    it('should display arrows for trend direction', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 85,
        fiveHourResetTime: new Date(now.getTime() + 3600000),
        sevenDayResetTime: new Date(now.getTime() + 86400000),
        fiveHourTrendPerHour: 2.5, // Upward
        sevenDayTrendPerDay: -0.5, // Downward
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('Trend:');
      // Should contain arrow indicators (↑, ↓, or →)
      expect(output).toMatch(/[↑↓→]/);
    });
  });

  describe('Projection Method Footer', () => {
    it('should display projection method information', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('Projection Method:');
      expect(output).toContain('Linear regression');
    });

    it('should display snapshot count in projection method', () => {
      const now = new Date();
      const snapshots = [];
      for (let i = 0; i < 15; i++) {
        snapshots.push({
          timestamp: new Date(now.getTime() - (14 - i) * 600000),
          fiveHour: 30 + i,
          sevenDay: 50 + i,
        });
      }

      const trajectory: TrajectoryResult = {
        snapshots,
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('15 snapshots');
    });

    it('should cap displayed snapshots at 30', () => {
      const now = new Date();
      const snapshots = [];
      for (let i = 0; i < 50; i++) {
        snapshots.push({
          timestamp: new Date(now.getTime() - (49 - i) * 600000),
          fiveHour: 30 + i % 20,
          sevenDay: 50 + i % 30,
        });
      }

      const trajectory: TrajectoryResult = {
        snapshots,
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('30 snapshots');
    });
  });
});
