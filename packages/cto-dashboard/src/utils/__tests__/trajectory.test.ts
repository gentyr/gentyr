/**
 * Unit tests for trajectory utilities
 *
 * Tests usage snapshot reading, aggregation, linear regression, and projections.
 * Validates the fix for reset time selection (earliest across keys, not last encountered).
 *
 * Philosophy: Validate structure and behavior, not performance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getUsageTrajectory, getChartSnapshots, getChartData } from '../trajectory.js';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const SNAPSHOTS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'usage-snapshots.json');
const BACKUP_PATH = SNAPSHOTS_PATH + '.test-backup';

describe('trajectory utilities', () => {
  describe('getUsageTrajectory', () => {
    beforeEach(() => {
      // Backup existing file if it exists
      if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.copyFileSync(SNAPSHOTS_PATH, BACKUP_PATH);
      }
    });

    afterEach(() => {
      // Restore backup
      if (fs.existsSync(BACKUP_PATH)) {
        fs.copyFileSync(BACKUP_PATH, SNAPSHOTS_PATH);
        fs.unlinkSync(BACKUP_PATH);
      } else if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.unlinkSync(SNAPSHOTS_PATH);
      }
    });

    it('should return empty result when file does not exist', () => {
      // Remove file if it exists
      if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.unlinkSync(SNAPSHOTS_PATH);
      }

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(false);
      expect(result.snapshots).toEqual([]);
      expect(result.fiveHourProjectedAtReset).toBeNull();
      expect(result.sevenDayProjectedAtReset).toBeNull();
      expect(result.fiveHourResetTime).toBeNull();
      expect(result.sevenDayResetTime).toBeNull();
      expect(result.fiveHourTrendPerHour).toBeNull();
      expect(result.sevenDayTrendPerDay).toBeNull();
    });

    it('should return empty result when file is malformed JSON', () => {
      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, 'invalid json{');

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(false);
      expect(result.snapshots).toEqual([]);
    });

    it('should return empty result when snapshots array is missing', () => {
      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify({ foo: 'bar' }));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(false);
      expect(result.snapshots).toEqual([]);
    });

    it('should return empty result when snapshots array is empty', () => {
      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify({ snapshots: [] }));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(false);
      expect(result.snapshots).toEqual([]);
    });

    it('should parse single snapshot with single key', () => {
      const now = Date.now();
      const resetTime5h = new Date(now + 3600000).toISOString(); // 1h from now
      const resetTime7d = new Date(now + 86400000).toISOString(); // 1d from now

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.5,
                '5h_reset': resetTime5h,
                '7d': 0.75,
                '7d_reset': resetTime7d,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].fiveHour).toBeCloseTo(50, 1); // 0.5 * 100 = 50%
      expect(result.snapshots[0].sevenDay).toBeCloseTo(75, 1); // 0.75 * 100 = 75%
      expect(result.fiveHourResetTime).not.toBeNull();
      expect(result.sevenDayResetTime).not.toBeNull();
    });

    it('should aggregate multiple keys by averaging', () => {
      const now = Date.now();
      const resetTime5h = new Date(now + 3600000).toISOString();
      const resetTime7d = new Date(now + 86400000).toISOString();

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.3,
                '5h_reset': resetTime5h,
                '7d': 0.5,
                '7d_reset': resetTime7d,
              },
              key2: {
                '5h': 0.7,
                '5h_reset': resetTime5h,
                '7d': 0.9,
                '7d_reset': resetTime7d,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.snapshots).toHaveLength(1);
      // Average of 0.3 and 0.7 = 0.5 => 50%
      expect(result.snapshots[0].fiveHour).toBeCloseTo(50, 1);
      // Average of 0.5 and 0.9 = 0.7 => 70%
      expect(result.snapshots[0].sevenDay).toBeCloseTo(70, 1);
    });

    it('should filter exhausted accounts (7d >= 0.995) from aggregate', () => {
      const now = Date.now();
      const resetTime5h = new Date(now + 3600000).toISOString();
      const resetTime7d = new Date(now + 86400000).toISOString();

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              active1: {
                '5h': 0.14,
                '5h_reset': resetTime5h,
                '7d': 0.40,
                '7d_reset': resetTime7d,
              },
              active2: {
                '5h': 0.20,
                '5h_reset': resetTime5h,
                '7d': 0.30,
                '7d_reset': resetTime7d,
              },
              exhausted: {
                '5h': 0.00,
                '5h_reset': resetTime5h,
                '7d': 1.00, // >= 0.995, should be excluded
                '7d_reset': resetTime7d,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.snapshots).toHaveLength(1);
      // Active-only 7d: (0.40 + 0.30) / 2 = 0.35 => 35%
      // Without filtering: (0.40 + 0.30 + 1.00) / 3 = 0.567 => 56.7%
      expect(result.snapshots[0].sevenDay).toBeCloseTo(35, 0);
      // Active-only 5h: (0.14 + 0.20) / 2 = 0.17 => 17%
      expect(result.snapshots[0].fiveHour).toBeCloseTo(17, 0);
    });

    it('should fall back to all-key average when ALL keys are exhausted', () => {
      const now = Date.now();
      const resetTime5h = new Date(now + 3600000).toISOString();
      const resetTime7d = new Date(now + 86400000).toISOString();

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              exhausted1: {
                '5h': 0.00,
                '5h_reset': resetTime5h,
                '7d': 1.00,
                '7d_reset': resetTime7d,
              },
              exhausted2: {
                '5h': 0.05,
                '5h_reset': resetTime5h,
                '7d': 0.999, // >= 0.995
                '7d_reset': resetTime7d,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      // All keys exhausted => fall back to all-key average
      // 7d: (1.00 + 0.999) / 2 = 0.9995 => ~100%
      expect(result.snapshots[0].sevenDay).toBeCloseTo(99.95, 0);
    });

    it('should select earliest reset time across keys (fix validation)', () => {
      const now = Date.now();
      const resetTime5h_early = new Date(now + 3600000).toISOString(); // 1h from now
      const resetTime5h_late = new Date(now + 7200000).toISOString(); // 2h from now
      const resetTime7d_early = new Date(now + 86400000).toISOString(); // 1d from now
      const resetTime7d_late = new Date(now + 172800000).toISOString(); // 2d from now

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.3,
                '5h_reset': resetTime5h_late, // Later time
                '7d': 0.5,
                '7d_reset': resetTime7d_late, // Later time
              },
              key2: {
                '5h': 0.7,
                '5h_reset': resetTime5h_early, // Earlier time - should be selected
                '7d': 0.9,
                '7d_reset': resetTime7d_early, // Earlier time - should be selected
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      // Should select the EARLIEST reset time across keys
      expect(result.fiveHourResetTime?.toISOString()).toBe(resetTime5h_early);
      expect(result.sevenDayResetTime?.toISOString()).toBe(resetTime7d_early);
    });

    it('should handle missing reset times gracefully', () => {
      const now = Date.now();

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.5,
                '7d': 0.75,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.fiveHourResetTime).toBeNull();
      expect(result.sevenDayResetTime).toBeNull();
    });

    it('should calculate projections with sufficient data points', () => {
      const now = Date.now();
      const resetTime5h = new Date(now + 3600000).toISOString();
      const resetTime7d = new Date(now + 86400000).toISOString();

      // Create linear trend: increasing by 10% per snapshot
      const snapshots = [];
      for (let i = 0; i < 10; i++) {
        snapshots.push({
          ts: now - (9 - i) * 600000, // 10 min intervals, going backwards
          keys: {
            key1: {
              '5h': 0.1 + i * 0.05, // Increasing trend
              '5h_reset': resetTime5h,
              '7d': 0.2 + i * 0.03, // Increasing trend
              '7d_reset': resetTime7d,
            },
          },
        });
      }

      const data = { snapshots };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.snapshots).toHaveLength(10);
      // Should have non-null trend rates
      expect(result.fiveHourTrendPerHour).not.toBeNull();
      expect(result.sevenDayTrendPerDay).not.toBeNull();
      // Trends should be positive (increasing)
      expect(result.fiveHourTrendPerHour!).toBeGreaterThan(0);
      expect(result.sevenDayTrendPerDay!).toBeGreaterThan(0);
      // Should have projections
      expect(result.fiveHourProjectedAtReset).not.toBeNull();
      expect(result.sevenDayProjectedAtReset).not.toBeNull();
      // Projections should be valid percentages
      expect(result.fiveHourProjectedAtReset!).toBeGreaterThanOrEqual(0);
      expect(result.fiveHourProjectedAtReset!).toBeLessThanOrEqual(100);
      expect(result.sevenDayProjectedAtReset!).toBeGreaterThanOrEqual(0);
      expect(result.sevenDayProjectedAtReset!).toBeLessThanOrEqual(100);
    });

    it('should return null projections with insufficient data points', () => {
      const now = Date.now();
      const resetTime5h = new Date(now + 3600000).toISOString();
      const resetTime7d = new Date(now + 86400000).toISOString();

      const data = {
        snapshots: [
          {
            ts: now - 1200000,
            keys: {
              key1: {
                '5h': 0.3,
                '5h_reset': resetTime5h,
                '7d': 0.5,
                '7d_reset': resetTime7d,
              },
            },
          },
          {
            ts: now - 600000,
            keys: {
              key1: {
                '5h': 0.4,
                '5h_reset': resetTime5h,
                '7d': 0.6,
                '7d_reset': resetTime7d,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.snapshots).toHaveLength(2);
      // Less than 3 snapshots => no projections
      expect(result.fiveHourTrendPerHour).toBeNull();
      expect(result.sevenDayTrendPerDay).toBeNull();
      expect(result.fiveHourProjectedAtReset).toBeNull();
      expect(result.sevenDayProjectedAtReset).toBeNull();
    });

    it('should clamp projections to 0-100 range', () => {
      const now = Date.now();
      const resetTime5h = new Date(now + 36000000).toISOString(); // 10h from now
      const resetTime7d = new Date(now + 864000000).toISOString(); // 10d from now

      // Create aggressive upward trend that will exceed 100%
      const snapshots = [];
      for (let i = 0; i < 10; i++) {
        snapshots.push({
          ts: now - (9 - i) * 600000,
          keys: {
            key1: {
              '5h': 0.8 + i * 0.05, // Starting high, increasing rapidly
              '5h_reset': resetTime5h,
              '7d': 0.85 + i * 0.03,
              '7d_reset': resetTime7d,
            },
          },
        });
      }

      const data = { snapshots };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      // Projections should be clamped to 100%
      expect(result.fiveHourProjectedAtReset!).toBeLessThanOrEqual(100);
      expect(result.sevenDayProjectedAtReset!).toBeLessThanOrEqual(100);
      expect(result.fiveHourProjectedAtReset!).toBeGreaterThanOrEqual(0);
      expect(result.sevenDayProjectedAtReset!).toBeGreaterThanOrEqual(0);
    });

    it('should convert fraction values (0-1) to percentages (0-100)', () => {
      const now = Date.now();

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.5, // Fraction
                '7d': 0.75, // Fraction
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.snapshots[0].fiveHour).toBeCloseTo(50, 1);
      expect(result.snapshots[0].sevenDay).toBeCloseTo(75, 1);
    });

    it('should skip snapshots with missing keys object', () => {
      const now = Date.now();

      const data = {
        snapshots: [
          {
            ts: now - 1200000,
            // Missing keys object
          },
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.5,
                '7d': 0.75,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      // Should only have 1 valid snapshot (second one)
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].fiveHour).toBeCloseTo(50, 1);
    });

    it('should skip snapshots with empty keys object', () => {
      const now = Date.now();

      const data = {
        snapshots: [
          {
            ts: now - 1200000,
            keys: {}, // Empty keys object
          },
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.5,
                '7d': 0.75,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      // Should only have 1 valid snapshot (second one)
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].fiveHour).toBeCloseTo(50, 1);
    });

    it('should skip snapshots where keys is not an object', () => {
      const now = Date.now();

      const data = {
        snapshots: [
          {
            ts: now - 1200000,
            keys: 'invalid', // Not an object
          },
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.5,
                '7d': 0.75,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      // Should only have 1 valid snapshot (second one)
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].fiveHour).toBeCloseTo(50, 1);
    });

    it('should handle already-percentage values without double conversion', () => {
      const now = Date.now();

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              key1: {
                '5h': 50, // Already a percentage
                '7d': 75, // Already a percentage
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getUsageTrajectory();

      expect(result.hasData).toBe(true);
      expect(result.snapshots[0].fiveHour).toBeCloseTo(50, 1);
      expect(result.snapshots[0].sevenDay).toBeCloseTo(75, 1);
    });
  });

  describe('getChartSnapshots', () => {
    beforeEach(() => {
      if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.copyFileSync(SNAPSHOTS_PATH, BACKUP_PATH);
      }
    });

    afterEach(() => {
      if (fs.existsSync(BACKUP_PATH)) {
        fs.copyFileSync(BACKUP_PATH, SNAPSHOTS_PATH);
        fs.unlinkSync(BACKUP_PATH);
      } else if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.unlinkSync(SNAPSHOTS_PATH);
      }
    });

    it('should return empty array when no data available', () => {
      if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.unlinkSync(SNAPSHOTS_PATH);
      }

      const snapshots = getChartSnapshots();

      expect(snapshots).toEqual([]);
    });

    it('should limit snapshots to maxPoints', () => {
      const now = Date.now();
      const snapshots = [];

      for (let i = 0; i < 50; i++) {
        snapshots.push({
          ts: now - (49 - i) * 600000,
          keys: {
            key1: {
              '5h': 0.5,
              '7d': 0.75,
            },
          },
        });
      }

      const data = { snapshots };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getChartSnapshots(30);

      expect(result).toHaveLength(30);
      // Should take the last 30 snapshots
      expect(result[0].timestamp.getTime()).toBeGreaterThan(
        result[result.length - 1].timestamp.getTime() - 31 * 600000,
      );
    });
  });

  describe('getChartData', () => {
    beforeEach(() => {
      if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.copyFileSync(SNAPSHOTS_PATH, BACKUP_PATH);
      }
    });

    afterEach(() => {
      if (fs.existsSync(BACKUP_PATH)) {
        fs.copyFileSync(BACKUP_PATH, SNAPSHOTS_PATH);
        fs.unlinkSync(BACKUP_PATH);
      } else if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.unlinkSync(SNAPSHOTS_PATH);
      }
    });

    it('should return empty arrays when no data available', () => {
      if (fs.existsSync(SNAPSHOTS_PATH)) {
        fs.unlinkSync(SNAPSHOTS_PATH);
      }

      const result = getChartData();

      expect(result.fiveHourData).toEqual([]);
      expect(result.sevenDayData).toEqual([]);
      expect(result.timestamps).toEqual([]);
    });

    it('should return parallel arrays of same length', () => {
      const now = Date.now();
      const snapshots = [];

      for (let i = 0; i < 10; i++) {
        snapshots.push({
          ts: now - (9 - i) * 600000,
          keys: {
            key1: {
              '5h': 0.3 + i * 0.05,
              '7d': 0.5 + i * 0.03,
            },
          },
        });
      }

      const data = { snapshots };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getChartData();

      expect(result.fiveHourData).toHaveLength(10);
      expect(result.sevenDayData).toHaveLength(10);
      expect(result.timestamps).toHaveLength(10);
      expect(result.fiveHourData.length).toBe(result.sevenDayData.length);
      expect(result.sevenDayData.length).toBe(result.timestamps.length);
    });

    it('should return correct data types', () => {
      const now = Date.now();

      const data = {
        snapshots: [
          {
            ts: now,
            keys: {
              key1: {
                '5h': 0.5,
                '7d': 0.75,
              },
            },
          },
        ],
      };

      const dir = path.dirname(SNAPSHOTS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(data));

      const result = getChartData();

      expect(typeof result.fiveHourData[0]).toBe('number');
      expect(typeof result.sevenDayData[0]).toBe('number');
      expect(result.timestamps[0]).toBeInstanceOf(Date);
      expect(result.fiveHourData[0]).not.toBeNaN();
      expect(result.sevenDayData[0]).not.toBeNaN();
    });
  });
});
