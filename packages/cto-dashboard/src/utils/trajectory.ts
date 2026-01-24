/**
 * Usage Trajectory Module
 *
 * Central module for reading usage snapshots and calculating projections.
 * Used by UsageTrends (line graphs) and UsageTrajectory (projections).
 *
 * Data source: .claude/state/usage-snapshots.json
 * Collected by: usage-optimizer.js every 10 minutes
 * Retention: 7 days
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const SNAPSHOTS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'usage-snapshots.json');

// ============================================================================
// Types
// ============================================================================

export interface UsageSnapshot {
  timestamp: Date;
  fiveHour: number;  // aggregate % (0-100)
  sevenDay: number;  // aggregate % (0-100)
}

export interface TrajectoryResult {
  snapshots: UsageSnapshot[];           // Actual historical data
  fiveHourProjectedAtReset: number | null;  // Projected % at reset (0-100)
  sevenDayProjectedAtReset: number | null;
  fiveHourResetTime: Date | null;
  sevenDayResetTime: Date | null;
  fiveHourTrendPerHour: number | null;  // % change per hour
  sevenDayTrendPerDay: number | null;   // % change per day
  hasData: boolean;
}

interface RawKeyData {
  '5h': number;
  '5h_reset': string;
  '7d': number;
  '7d_reset': string;
}

interface RawSnapshot {
  ts: number;
  keys: Record<string, RawKeyData>;
}

interface SnapshotsFile {
  snapshots: RawSnapshot[];
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Get usage trajectory data including historical snapshots and projections.
 * Returns empty result if no data available (graceful degradation).
 */
export function getUsageTrajectory(): TrajectoryResult {
  const emptyResult: TrajectoryResult = {
    snapshots: [],
    fiveHourProjectedAtReset: null,
    sevenDayProjectedAtReset: null,
    fiveHourResetTime: null,
    sevenDayResetTime: null,
    fiveHourTrendPerHour: null,
    sevenDayTrendPerDay: null,
    hasData: false,
  };

  if (!fs.existsSync(SNAPSHOTS_PATH)) {
    return emptyResult;
  }

  let data: SnapshotsFile;
  try {
    const content = fs.readFileSync(SNAPSHOTS_PATH, 'utf8');
    data = JSON.parse(content) as SnapshotsFile;
  } catch {
    return emptyResult;
  }

  if (!data || !Array.isArray(data.snapshots) || data.snapshots.length === 0) {
    return emptyResult;
  }

  // Convert raw snapshots to aggregated UsageSnapshots
  const snapshots: UsageSnapshot[] = [];
  let latestReset5h: string | null = null;
  let latestReset7d: string | null = null;

  for (const raw of data.snapshots) {
    const aggregate = calculateAggregate(raw);
    if (aggregate) {
      snapshots.push({
        timestamp: new Date(raw.ts),
        fiveHour: aggregate.fiveHour,
        sevenDay: aggregate.sevenDay,
      });

      // Track latest reset times from the most recent snapshot
      if (aggregate.reset5h) latestReset5h = aggregate.reset5h;
      if (aggregate.reset7d) latestReset7d = aggregate.reset7d;
    }
  }

  if (snapshots.length === 0) {
    return emptyResult;
  }

  // Parse reset times
  const fiveHourResetTime = latestReset5h ? new Date(latestReset5h) : null;
  const sevenDayResetTime = latestReset7d ? new Date(latestReset7d) : null;

  // Calculate trends and projections using linear regression on recent snapshots
  const recentSnapshots = snapshots.slice(-30); // Use last 30 snapshots

  const {
    fiveHourTrendPerHour,
    sevenDayTrendPerHour,
    fiveHourProjectedAtReset,
    sevenDayProjectedAtReset,
  } = calculateProjections(recentSnapshots, fiveHourResetTime, sevenDayResetTime);

  return {
    snapshots,
    fiveHourProjectedAtReset,
    sevenDayProjectedAtReset,
    fiveHourResetTime,
    sevenDayResetTime,
    fiveHourTrendPerHour,
    sevenDayTrendPerDay: sevenDayTrendPerHour !== null ? sevenDayTrendPerHour * 24 : null,
    hasData: true,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

interface AggregateResult {
  fiveHour: number;
  sevenDay: number;
  reset5h: string | null;
  reset7d: string | null;
}

/**
 * Calculate aggregate usage across all keys in a snapshot.
 * Values are percentages (0-100).
 */
function calculateAggregate(raw: RawSnapshot): AggregateResult | null {
  if (!raw.keys || typeof raw.keys !== 'object') {
    return null;
  }

  const entries = Object.values(raw.keys);
  if (entries.length === 0) {
    return null;
  }

  let sum5h = 0;
  let sum7d = 0;
  let reset5h: string | null = null;
  let reset7d: string | null = null;

  for (const k of entries) {
    sum5h += k['5h'] ?? 0;
    sum7d += k['7d'] ?? 0;
    if (k['5h_reset']) reset5h = k['5h_reset'];
    if (k['7d_reset']) reset7d = k['7d_reset'];
  }

  return {
    fiveHour: sum5h / entries.length,
    sevenDay: sum7d / entries.length,
    reset5h,
    reset7d,
  };
}

interface ProjectionResult {
  fiveHourTrendPerHour: number | null;
  sevenDayTrendPerHour: number | null;
  fiveHourProjectedAtReset: number | null;
  sevenDayProjectedAtReset: number | null;
}

/**
 * Calculate trend rates and projections using linear regression.
 */
function calculateProjections(
  snapshots: UsageSnapshot[],
  fiveHourResetTime: Date | null,
  sevenDayResetTime: Date | null,
): ProjectionResult {
  if (snapshots.length < 3) {
    return {
      fiveHourTrendPerHour: null,
      sevenDayTrendPerHour: null,
      fiveHourProjectedAtReset: null,
      sevenDayProjectedAtReset: null,
    };
  }

  // Extract data points for regression
  const now = Date.now();
  const firstTime = snapshots[0].timestamp.getTime();

  const x: number[] = []; // hours since first snapshot
  const y5h: number[] = [];
  const y7d: number[] = [];

  for (const snap of snapshots) {
    const hoursFromStart = (snap.timestamp.getTime() - firstTime) / (1000 * 60 * 60);
    x.push(hoursFromStart);
    y5h.push(snap.fiveHour);
    y7d.push(snap.sevenDay);
  }

  // Linear regression for 5-hour metric
  const lr5h = linearRegression(x, y5h);
  const lr7d = linearRegression(x, y7d);

  // Calculate projections at reset time
  let fiveHourProjectedAtReset: number | null = null;
  let sevenDayProjectedAtReset: number | null = null;

  const hoursFromStartToNow = (now - firstTime) / (1000 * 60 * 60);

  if (fiveHourResetTime && lr5h) {
    const hoursUntilReset = (fiveHourResetTime.getTime() - now) / (1000 * 60 * 60);
    if (hoursUntilReset > 0) {
      const hoursFromStartToReset = hoursFromStartToNow + hoursUntilReset;
      const projected = lr5h.slope * hoursFromStartToReset + lr5h.intercept;
      fiveHourProjectedAtReset = Math.max(0, Math.min(100, projected));
    }
  }

  if (sevenDayResetTime && lr7d) {
    const hoursUntilReset = (sevenDayResetTime.getTime() - now) / (1000 * 60 * 60);
    if (hoursUntilReset > 0) {
      const hoursFromStartToReset = hoursFromStartToNow + hoursUntilReset;
      const projected = lr7d.slope * hoursFromStartToReset + lr7d.intercept;
      sevenDayProjectedAtReset = Math.max(0, Math.min(100, projected));
    }
  }

  return {
    fiveHourTrendPerHour: lr5h?.slope ?? null,
    sevenDayTrendPerHour: lr7d?.slope ?? null,
    fiveHourProjectedAtReset,
    sevenDayProjectedAtReset,
  };
}

interface RegressionResult {
  slope: number;
  intercept: number;
}

/**
 * Simple linear regression: y = mx + b
 * Returns slope (m) and intercept (b).
 */
function linearRegression(x: number[], y: number[]): RegressionResult | null {
  const n = x.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumXX += x[i] * x[i];
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

/**
 * Get just the recent snapshots for chart rendering.
 * Limits to a specific number of data points.
 */
export function getChartSnapshots(maxPoints: number = 30): UsageSnapshot[] {
  const trajectory = getUsageTrajectory();
  if (!trajectory.hasData) return [];

  return trajectory.snapshots.slice(-maxPoints);
}

/**
 * Format trajectory data for LineGraph component.
 * Returns separate arrays for 5h and 7d data.
 */
export function getChartData(maxPoints: number = 30): {
  fiveHourData: number[];
  sevenDayData: number[];
  timestamps: Date[];
} {
  const snapshots = getChartSnapshots(maxPoints);

  return {
    fiveHourData: snapshots.map(s => s.fiveHour),
    sevenDayData: snapshots.map(s => s.sevenDay),
    timestamps: snapshots.map(s => s.timestamp),
  };
}
