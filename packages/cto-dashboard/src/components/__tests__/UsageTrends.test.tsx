/**
 * Unit tests for UsageTrends component
 *
 * Tests rendering behavior for usage trend graphs:
 * - 5-hour usage line graph
 * - 7-day usage line graph
 * - Trajectory forecast graph (history + projections)
 * - Helper functions: formatTimeUntil, generateProjectionPoints
 * - Conditional rendering based on data availability
 * - Empty state handling
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { UsageTrends } from '../UsageTrends.js';
import type { TrajectoryResult } from '../../utils/trajectory.js';

describe('UsageTrends', () => {
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

      const { lastFrame } = render(<UsageTrends trajectory={emptyTrajectory} />);
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

      const { lastFrame } = render(<UsageTrends trajectory={emptyTrajectory} />);
      expect(lastFrame()).toBe('');
    });
  });

  describe('Basic Rendering', () => {
    it('should render 5-hour and 7-day graphs with data', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: new Date(now.getTime() - 1800000), fiveHour: 40, sevenDay: 55 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('5-Hour Usage');
      expect(output).toContain('7-Day Usage');
      expect(output).toContain('Current:');
      expect(output).toContain('Min:');
      expect(output).toContain('Max:');
    });

    it('should display current, min, and max values correctly', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: new Date(now.getTime() - 1800000), fiveHour: 60, sevenDay: 80 },
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

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Current should be last value
      expect(output).toMatch(/Current:\s*45%/);
      // Min 5h should be 30
      expect(output).toMatch(/Min:\s*30%/);
      // Max 5h should be 60
      expect(output).toMatch(/Max:\s*60%/);
    });

    it('should handle single snapshot data point', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [{ timestamp: now, fiveHour: 42, sevenDay: 67 }],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Min, max, and current should all be the same
      expect(output).toMatch(/Current:\s*42%/);
      expect(output).toMatch(/Min:\s*42%/);
      expect(output).toMatch(/Max:\s*42%/);
    });
  });

  describe('Trajectory Forecast Graph', () => {
    it('should not render forecast when no projections available', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 40, sevenDay: 55 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).not.toContain('Forecast');
    });

    it('should render forecast when reset times are in the future', () => {
      const now = new Date();
      const futureReset5h = new Date(now.getTime() + 3600000); // 1h from now
      const futureReset7d = new Date(now.getTime() + 86400000); // 1d from now

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: new Date(now.getTime() - 1800000), fiveHour: 40, sevenDay: 55 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 75,
        fiveHourResetTime: futureReset5h,
        sevenDayResetTime: futureReset7d,
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 3.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('5-Hour Forecast');
      expect(output).toContain('7-Day Forecast');
      expect(output).toContain('history → projection');
    });

    it('should not render forecast when reset times are in the past', () => {
      const now = new Date();
      const pastReset5h = new Date(now.getTime() - 3600000); // 1h ago
      const pastReset7d = new Date(now.getTime() - 86400000); // 1d ago

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 7200000), fiveHour: 30, sevenDay: 50 },
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 40, sevenDay: 55 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: pastReset5h,
        sevenDayResetTime: pastReset7d,
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 3.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).not.toContain('Forecast');
    });

    it('should show reset time label in forecast', () => {
      const now = new Date();
      const futureReset5h = new Date(now.getTime() + 3600000); // 1h from now

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 75,
        fiveHourResetTime: futureReset5h,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 3.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('reset:');
    });
  });

  describe('formatTimeUntil helper', () => {
    // Since formatTimeUntil is not exported, we test it indirectly via component rendering
    it('should format time until reset correctly in minutes', () => {
      const now = new Date();
      const futureReset = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 75,
        fiveHourResetTime: futureReset,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 3.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show "30m" or similar
      expect(output).toMatch(/reset:\s*\d+m/);
    });

    it('should format time until reset correctly in hours', () => {
      const now = new Date();
      const futureReset = new Date(now.getTime() + 2.5 * 60 * 60 * 1000); // 2.5 hours

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 75,
        fiveHourResetTime: futureReset,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 3.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show "2h 30m" or similar
      expect(output).toMatch(/reset:\s*\d+h/);
    });

    it('should format time until reset correctly in days', () => {
      const now = new Date();
      const futureReset = new Date(now.getTime() + 2.5 * 24 * 60 * 60 * 1000); // 2.5 days

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 75,
        fiveHourResetTime: futureReset,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 3.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show "2d 12h" or similar
      expect(output).toMatch(/reset:\s*\d+d/);
    });
  });

  describe('generateProjectionPoints behavior', () => {
    // Since generateProjectionPoints is not exported, we test it indirectly
    it('should generate forecast when trend and reset time are available', () => {
      const now = new Date();
      const futureReset = new Date(now.getTime() + 3600000); // 1h from now

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 75,
        fiveHourResetTime: futureReset,
        sevenDayResetTime: futureReset,
        fiveHourTrendPerHour: 20.0, // High trend
        sevenDayTrendPerDay: 360.0, // = 15.0 per hour
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should render separate forecast graphs
      expect(output).toContain('5-Hour Forecast');
      expect(output).toContain('7-Day Forecast');
    });

    it('should not generate forecast when trend is null', () => {
      const now = new Date();
      const futureReset = new Date(now.getTime() + 3600000);

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: futureReset,
        sevenDayResetTime: futureReset,
        fiveHourTrendPerHour: null, // No trend
        sevenDayTrendPerDay: null, // No trend
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).not.toContain('Forecast');
    });

    it('should not generate forecast when reset time is null', () => {
      const now = new Date();

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null, // No reset time
        sevenDayResetTime: null, // No reset time
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 3.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).not.toContain('Forecast');
    });
  });

  describe('Reset Time Selection', () => {
    it('should use earliest reset time for projection horizon', () => {
      const now = new Date();
      const earlierReset = new Date(now.getTime() + 3600000); // 1h from now
      const laterReset = new Date(now.getTime() + 7200000); // 2h from now

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 75,
        fiveHourResetTime: earlierReset, // Earlier
        sevenDayResetTime: laterReset, // Later
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 120.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show forecast with reset time around 1h
      expect(output).toContain('5-Hour Forecast');
      expect(output).toMatch(/reset:\s*(1h|59m|5[0-9]m)/);
    });

    it('should ignore past reset times when selecting earliest', () => {
      const now = new Date();
      const pastReset = new Date(now.getTime() - 3600000); // 1h ago
      const futureReset = new Date(now.getTime() + 3600000); // 1h from now

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 7200000), fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: futureReset,
        sevenDayResetTime: pastReset, // Past - should be ignored
        fiveHourTrendPerHour: 5.0,
        sevenDayTrendPerDay: 120.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show forecast using the future reset time
      expect(output).toContain('5-Hour Forecast');
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero values correctly', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 0, sevenDay: 0 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('0%');
    });

    it('should handle 100% values correctly', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 100, sevenDay: 100 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('100%');
    });

    it('should handle negative trend (decreasing usage)', () => {
      const now = new Date();
      const futureReset = new Date(now.getTime() + 3600000);

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: new Date(now.getTime() - 3600000), fiveHour: 70, sevenDay: 80 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: 30, // Projected to decrease
        sevenDayProjectedAtReset: 40,
        fiveHourResetTime: futureReset,
        sevenDayResetTime: futureReset,
        fiveHourTrendPerHour: -20.0, // Negative trend
        sevenDayTrendPerDay: -480.0, // = -20.0 per hour
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should still render forecast with decreasing trend
      expect(output).toContain('5-Hour Forecast');
      expect(output).toContain('7-Day Forecast');
    });

    it('should handle fractional percentages correctly', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 42.7, sevenDay: 67.3 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should round to nearest integer
      expect(output).toMatch(/Current:\s*43%/);
    });
  });

  describe('Time Range Display', () => {
    it('should show time ago for oldest snapshot in minutes', () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - 30 * 60 * 1000); // 30 minutes ago

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: oldTime, fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show "30m ago" or similar
      expect(output).toMatch(/\d+m ago/);
    });

    it('should show time ago for oldest snapshot in hours', () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: oldTime, fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show "2h ago" or similar
      expect(output).toMatch(/\d+h ago/);
    });

    it('should show time ago for oldest snapshot in days', () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: oldTime, fiveHour: 30, sevenDay: 50 },
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      // Should show "3d ago" or similar
      expect(output).toMatch(/\d+d ago/);
    });

    it('should show snapshot count', () => {
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

      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('15 snapshots');
    });
  });

  describe('Props Interface Change', () => {
    it('should accept trajectory prop (not separate snapshots and hasData)', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      // This should compile and run without errors
      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('5-Hour Usage');
    });

    it('should destructure hasData and snapshots from trajectory prop', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 50, sevenDay: 60 },
        ],
        fiveHourProjectedAtReset: null,
        sevenDayProjectedAtReset: null,
        fiveHourResetTime: null,
        sevenDayResetTime: null,
        fiveHourTrendPerHour: null,
        sevenDayTrendPerDay: null,
        hasData: true,
      };

      // Component should properly access hasData and snapshots from trajectory
      const { lastFrame } = render(<UsageTrends trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).not.toBe('');
      expect(output).toContain('USAGE TRENDS');
    });
  });
});
