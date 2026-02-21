/**
 * Unit tests for UsageTrajectory component
 *
 * Tests rendering behavior for usage trajectory projections:
 * - Side-by-side 5-hour and 7-day window cards
 * - Current usage, projected usage, reset time, trend display
 * - Per-account quota bars (AccountQuotaBars sub-component)
 * - Conditional rendering based on data availability
 * - Multi-key aggregation display
 * - Empty state handling
 *
 * Philosophy: Validate structure and behavior, not visual appearance.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { UsageTrajectory } from '../UsageTrajectory.js';
import type { TrajectoryResult } from '../../utils/trajectory.js';
import type { VerifiedQuotaResult } from '../../utils/data-reader.js';
import type { AccountOverviewData } from '../../utils/account-overview-reader.js';

/**
 * Helper to generate AccountOverviewData from VerifiedQuotaResult keys
 */
function makeAccountOverview(verifiedQuota: VerifiedQuotaResult): AccountOverviewData {
  return {
    hasData: true,
    activeKeyId: verifiedQuota.keys.find(k => k.is_current)?.key_id ?? null,
    totalRotations24h: verifiedQuota.rotation_events_24h,
    accounts: verifiedQuota.keys
      .filter(k => k.healthy && k.quota)
      .map((k, idx) => ({
        keyId: k.key_id,
        status: 'active' as const,
        isCurrent: k.is_current,
        subscriptionType: k.subscription_type,
        email: `account${idx + 1}@test.com`,
        expiresAt: new Date(),
        addedAt: new Date(),
        lastUsedAt: new Date(),
        fiveHourPct: k.quota!.five_hour.utilization,
        sevenDayPct: k.quota!.seven_day.utilization,
        sevenDaySonnetPct: null,
      })),
    events: [],
  };
}

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

  describe('AccountQuotaBars Sub-Component', () => {
    it('should not render quota bars when verifiedQuota is undefined', () => {
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

      expect(output).not.toContain('Per-Account Quota');
    });

    it('should not render quota bars when only 1 healthy key', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'a3f8d21c...',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 1,
        total_attempted: 1,
        aggregate: {
          five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 0,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} />);
      const output = lastFrame();

      expect(output).not.toContain('Per-Account Quota');
    });

    it('should render quota bars when multiple healthy keys', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'a3f8d21c...',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'b7c4e92f...',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 98, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 100, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'c9d5f13a...',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 12, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 45, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 3,
        total_attempted: 3,
        aggregate: {
          five_hour: { utilization: 48, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 78, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 2,
      };

      const accountOverview = makeAccountOverview(verifiedQuota);

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      expect(output).toContain('Per-Account Quota');
      expect(output).toContain('* = active');
    });

    it('should display Total aggregate quota bar', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'key1',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 30, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 60, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'key2',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 70, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 90, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 2,
        aggregate: {
          five_hour: { utilization: 50, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 75, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = makeAccountOverview(verifiedQuota);

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      expect(output).toContain('Total');
      expect(output).toContain('5-Hour');
      expect(output).toContain('7-Day');
    });

    it('should display individual key quota bars', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'a3f8d21c...',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'b7c4e92f...',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 98, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 100, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 2,
        aggregate: {
          five_hour: { utilization: 66, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 94, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = makeAccountOverview(verifiedQuota);

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Component displays emails when available, not key IDs
      expect(output).toContain('account1@test.com');
      expect(output).toContain('account2@test.com');
    });

    it('should mark active key with asterisk', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'active_key',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'inactive_key',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 98, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 100, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 2,
        aggregate: {
          five_hour: { utilization: 66, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 94, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = makeAccountOverview(verifiedQuota);

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Component displays emails when available
      expect(output).toContain('account1@test.com *');
      expect(output).toContain('account2@test.com');
      // Verify inactive key doesn't have asterisk (account for padding)
      const lines = output!.split('\n');
      const inactiveKeyLine = lines.find(line => line.includes('account2@test.com'));
      expect(inactiveKeyLine).not.toMatch(/account2@test\.com\s+\*/);
    });

    it('should skip unhealthy keys in quota bars', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'healthy_key',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'unhealthy_key',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: false,
            quota: null,
          },
          {
            key_id: 'another_healthy',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 50, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 70, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 3,
        aggregate: {
          five_hour: { utilization: 42, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 79, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = makeAccountOverview(verifiedQuota);

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Component displays emails when available (only healthy keys with quota are shown)
      expect(output).toContain('account1@test.com'); // healthy_key
      expect(output).toContain('account2@test.com'); // another_healthy
      expect(output).not.toContain('unhealthy_key');
    });

    it('should skip keys with null quota', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'valid_key',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'null_quota_key',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: null,
          },
          {
            key_id: 'another_valid',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 50, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 70, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 3,
        total_attempted: 3,
        aggregate: {
          five_hour: { utilization: 42, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 79, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = makeAccountOverview(verifiedQuota);

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Component displays emails when available (only keys with quota are shown)
      expect(output).toContain('account1@test.com'); // valid_key
      expect(output).toContain('account2@test.com'); // another_valid
      expect(output).not.toContain('null_quota_key');
    });

    it('should display 5-hour and 7-day sections separately', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'key1',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'key2',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 98, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 100, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 2,
        aggregate: {
          five_hour: { utilization: 66, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 94, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = makeAccountOverview(verifiedQuota);

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Verify both sections exist
      expect(output).toContain('Per-Account Quota');
      expect(output).toContain('5-Hour');
      expect(output).toContain('7-Day');
      expect(output).toContain('Total');
      // Verify keys are shown (component displays emails when available)
      expect(output).toContain('account1@test.com');
      expect(output).toContain('account2@test.com');
    });
  });

  describe('Edge Cases', () => {
    it('should handle very high projected values (clamped to 100)', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 90, sevenDay: 95 },
        ],
        fiveHourProjectedAtReset: 150, // Over 100
        sevenDayProjectedAtReset: 200, // Over 100
        fiveHourResetTime: new Date(now.getTime() + 3600000),
        sevenDayResetTime: new Date(now.getTime() + 86400000),
        fiveHourTrendPerHour: 10.0,
        sevenDayTrendPerDay: 5.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      // Implementation should clamp or handle gracefully
      expect(output).toBeTruthy();
      expect(output).toContain('At Reset:');
    });

    it('should handle negative projected values', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 10, sevenDay: 15 },
        ],
        fiveHourProjectedAtReset: -5, // Negative
        sevenDayProjectedAtReset: -10, // Negative
        fiveHourResetTime: new Date(now.getTime() + 3600000),
        sevenDayResetTime: new Date(now.getTime() + 86400000),
        fiveHourTrendPerHour: -2.0,
        sevenDayTrendPerDay: -1.0,
        hasData: true,
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      // Implementation should clamp to 0 or handle gracefully
      expect(output).toBeTruthy();
      expect(output).toContain('At Reset:');
    });

    it('should handle zero current usage', () => {
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

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('0%');
    });

    it('should handle 100% current usage', () => {
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

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} />);
      const output = lastFrame();

      expect(output).toContain('100%');
    });

    it('should handle fractional percentages (rounded)', () => {
      const now = new Date();
      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: now, fiveHour: 45.7, sevenDay: 65.3 },
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

      // Should round to nearest integer
      expect(output).toMatch(/46%/);
      expect(output).toMatch(/65%/);
    });
  });

  describe('Component Structure Validation', () => {
    it('should return a React element when hasData is true', () => {
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

      const result = render(<UsageTrajectory trajectory={trajectory} />);

      expect(result).toBeDefined();
      expect(result.lastFrame()).toBeTruthy();
    });

    it('should maintain consistent structure across renders', () => {
      // Use a fixed timestamp to avoid time rendering inconsistencies
      const fixedNow = new Date('2026-02-20T12:00:00.000Z');
      const fixedResetTime5h = new Date('2026-02-20T14:00:00.000Z'); // Exactly 2 hours
      const fixedResetTime7d = new Date('2026-02-21T12:00:00.000Z'); // Exactly 1 day

      const trajectory: TrajectoryResult = {
        snapshots: [
          { timestamp: fixedNow, fiveHour: 45, sevenDay: 65 },
        ],
        fiveHourProjectedAtReset: 70,
        sevenDayProjectedAtReset: 85,
        fiveHourResetTime: fixedResetTime5h,
        sevenDayResetTime: fixedResetTime7d,
        fiveHourTrendPerHour: 2.5,
        sevenDayTrendPerDay: 0.5,
        hasData: true,
      };

      const render1 = render(<UsageTrajectory trajectory={trajectory} />);
      const render2 = render(<UsageTrajectory trajectory={trajectory} />);

      // Structure should be identical with fixed timestamps
      expect(render1.lastFrame()).toBe(render2.lastFrame());
    });
  });

  describe('Email Deduplication Logic', () => {
    it('should deduplicate accounts with same email address', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'key1',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'key2',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 50, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 70, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 2,
        aggregate: {
          five_hour: { utilization: 42, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 79, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = {
        hasData: true,
        activeKeyId: 'key1',
        totalRotations24h: 1,
        accounts: [
          {
            keyId: 'key1',
            status: 'active' as const,
            isCurrent: true,
            subscriptionType: 'claude_max',
            email: 'duplicate@test.com',
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 35,
            sevenDayPct: 88,
            sevenDaySonnetPct: null,
          },
          {
            keyId: 'key2',
            status: 'active' as const,
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'duplicate@test.com', // Same email
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 50,
            sevenDayPct: 70,
            sevenDaySonnetPct: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Should only show one account, not both duplicates (after deduplication only 1 unique email remains)
      expect(output).not.toContain('Per-Account Quota');
    });

    it('should show quota bars when multiple unique emails exist', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'key1',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'key2',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 50, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 70, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 2,
        aggregate: {
          five_hour: { utilization: 42, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 79, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = {
        hasData: true,
        activeKeyId: 'key1',
        totalRotations24h: 1,
        accounts: [
          {
            keyId: 'key1',
            status: 'active' as const,
            isCurrent: true,
            subscriptionType: 'claude_max',
            email: 'unique1@test.com',
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 35,
            sevenDayPct: 88,
            sevenDaySonnetPct: null,
          },
          {
            keyId: 'key2',
            status: 'active' as const,
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'unique2@test.com', // Different email
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 50,
            sevenDayPct: 70,
            sevenDaySonnetPct: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      expect(output).toContain('Per-Account Quota'); // Should show quota bars for 2 unique accounts
    });

    it('should use keyId as fallback when email is null', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'key1',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'key2',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 50, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 70, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 2,
        total_attempted: 2,
        aggregate: {
          five_hour: { utilization: 42, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 79, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 1,
      };

      const accountOverview = {
        hasData: true,
        activeKeyId: 'key1',
        totalRotations24h: 1,
        accounts: [
          {
            keyId: 'key1',
            status: 'active' as const,
            isCurrent: true,
            subscriptionType: 'claude_max',
            email: null, // No email - should use keyId
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 35,
            sevenDayPct: 88,
            sevenDaySonnetPct: null,
          },
          {
            keyId: 'key2',
            status: 'active' as const,
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: null, // No email - should use keyId
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 50,
            sevenDayPct: 70,
            sevenDaySonnetPct: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Should show both accounts since keyIds are unique
      expect(output).toContain('Per-Account Quota');
      expect(output).toContain('key1');
      expect(output).toContain('key2');
    });

    it('should keep first account when duplicates exist', () => {
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

      const verifiedQuota: VerifiedQuotaResult = {
        keys: [
          {
            key_id: 'key1',
            subscription_type: 'claude_max',
            is_current: true,
            healthy: true,
            quota: {
              five_hour: { utilization: 35, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 88, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'key2',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 70, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 90, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
          {
            key_id: 'key3',
            subscription_type: 'claude_max',
            is_current: false,
            healthy: true,
            quota: {
              five_hour: { utilization: 50, resets_at: new Date().toISOString(), resets_in_hours: 2 },
              seven_day: { utilization: 75, resets_at: new Date().toISOString(), resets_in_hours: 100 },
              extra_usage_enabled: false,
              error: null,
            },
          },
        ],
        healthy_count: 3,
        total_attempted: 3,
        aggregate: {
          five_hour: { utilization: 52, resets_at: new Date().toISOString(), resets_in_hours: 2 },
          seven_day: { utilization: 84, resets_at: new Date().toISOString(), resets_in_hours: 100 },
          extra_usage_enabled: false,
          error: null,
        },
        rotation_events_24h: 2,
      };

      const accountOverview = {
        hasData: true,
        activeKeyId: 'key1',
        totalRotations24h: 2,
        accounts: [
          {
            keyId: 'key1',
            status: 'active' as const,
            isCurrent: true,
            subscriptionType: 'claude_max',
            email: 'shared@test.com',
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 35,
            sevenDayPct: 88,
            sevenDaySonnetPct: null,
          },
          {
            keyId: 'key2',
            status: 'active' as const,
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'unique@test.com',
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 70,
            sevenDayPct: 90,
            sevenDaySonnetPct: null,
          },
          {
            keyId: 'key3',
            status: 'active' as const,
            isCurrent: false,
            subscriptionType: 'claude_max',
            email: 'shared@test.com', // Same as key1
            expiresAt: new Date(),
            addedAt: new Date(),
            lastUsedAt: new Date(),
            fiveHourPct: 50,
            sevenDayPct: 75,
            sevenDaySonnetPct: null,
          },
        ],
        events: [],
      };

      const { lastFrame } = render(<UsageTrajectory trajectory={trajectory} verifiedQuota={verifiedQuota} accountOverview={accountOverview} />);
      const output = lastFrame();

      // Should show quota bars (2 unique emails)
      expect(output).toContain('Per-Account Quota');
      // Should show first occurrence (key1 with 35%)
      expect(output).toContain('35%');
      // Should show unique account (key2 with 70%)
      expect(output).toContain('70%');
      // Should NOT show duplicate (key3 with 50%) - this validates deduplication
      expect(output).not.toContain('50%');
    });
  });
});
