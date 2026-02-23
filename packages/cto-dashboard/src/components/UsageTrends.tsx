/**
 * Usage Trends Component
 *
 * Displays historical line graphs for 5-hour and 7-day usage,
 * plus separate trajectory forecast graphs showing history + projections.
 * Uses @pppp606/ink-chart LineGraph for high-resolution rendering.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { LineGraph } from '@pppp606/ink-chart';
import { Section } from './Section.js';
import type { TrajectoryResult } from '../utils/trajectory.js';

export interface UsageTrendsProps {
  trajectory: TrajectoryResult;
  tip?: string;
}

/**
 * Format time ago string
 */
function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${Math.floor(diffHours / 24)}d ago`;
}

/**
 * Format duration until a future time as "Xh Ym" style string.
 */
function formatTimeUntil(resetTime: Date | null): string {
  if (!resetTime) return 'N/A';

  const now = Date.now();
  const diffMs = resetTime.getTime() - now;

  if (diffMs <= 0) return 'now';

  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  if (diffHours < 24) {
    const mins = diffMins % 60;
    return mins > 0 ? `${diffHours}h ${mins}m` : `${diffHours}h`;
  }
  const hours = diffHours % 24;
  return hours > 0 ? `${diffDays}d ${hours}h` : `${diffDays}d`;
}

/**
 * Generate projection points by linearly extrapolating from lastValue.
 * Points are evenly spaced between now and resetTime.
 * Each point is clamped to [0, 100].
 * Returns empty array if trendPerHour is null or resetTime is in the past.
 */
function generateProjectionPoints(
  lastValue: number,
  trendPerHour: number | null,
  resetTime: Date | null,
  pointCount: number,
): number[] {
  if (trendPerHour === null || !resetTime) return [];

  const now = Date.now();
  const msUntilReset = resetTime.getTime() - now;
  if (msUntilReset <= 0) return [];

  const hoursUntilReset = msUntilReset / (1000 * 60 * 60);
  const points: number[] = [];

  for (let i = 1; i <= pointCount; i++) {
    const hoursAhead = (i / pointCount) * hoursUntilReset;
    const projected = lastValue + trendPerHour * hoursAhead;
    points.push(Math.max(0, Math.min(100, projected)));
  }

  return points;
}

export function UsageTrends({ trajectory, tip }: UsageTrendsProps): React.ReactElement | null {
  const { snapshots, hasData } = trajectory;

  if (!hasData || snapshots.length === 0) {
    return null;
  }

  // Extract data for charts
  const fiveHourData = snapshots.map(s => s.fiveHour);
  const sevenDayData = snapshots.map(s => s.sevenDay);

  // Get time range
  const firstTime = snapshots[0].timestamp;

  // Calculate current and min/max values
  const current5h = fiveHourData[fiveHourData.length - 1];
  const current7d = sevenDayData[sevenDayData.length - 1];
  const min5h = Math.min(...fiveHourData);
  const max5h = Math.max(...fiveHourData);
  const min7d = Math.min(...sevenDayData);
  const max7d = Math.max(...sevenDayData);

  // Build trajectory forecast data
  // Use earliest reset time across both windows for the projection horizon
  const resetTimes = [trajectory.fiveHourResetTime, trajectory.sevenDayResetTime].filter(
    (t): t is Date => t !== null && t.getTime() > Date.now(),
  );
  const earliestReset = resetTimes.length > 0
    ? new Date(Math.min(...resetTimes.map(t => t.getTime())))
    : null;

  const projectionPointCount = snapshots.length;
  const projection5h = generateProjectionPoints(
    current5h,
    trajectory.fiveHourTrendPerHour,
    earliestReset,
    projectionPointCount,
  );
  const sevenDayTrendPerHour = trajectory.sevenDayTrendPerDay !== null
    ? trajectory.sevenDayTrendPerDay / 24
    : null;
  const projection7d = generateProjectionPoints(
    current7d,
    sevenDayTrendPerHour,
    earliestReset,
    projectionPointCount,
  );

  // Build separate forecast series: history + projection per metric
  const combined5h = [...fiveHourData, ...projection5h];
  const combined7d = [...sevenDayData, ...projection7d];
  const targetLine5h = Array(combined5h.length).fill(90);
  const targetLine7d = Array(combined7d.length).fill(90);

  const hasForecast5h = projection5h.length > 0;
  const hasForecast7d = projection7d.length > 0;

  // X-axis labels: [timeAgo, "now", "reset: Xh"]
  const resetLabel = earliestReset ? `reset: ${formatTimeUntil(earliestReset)}` : 'reset: N/A';
  const forecastXLabels = [formatTimeAgo(firstTime), 'now', resetLabel];

  return (
    <Section title="USAGE TRENDS" borderColor="blue" width="100%" tip={tip}>
      <Box flexDirection="column" gap={1}>
        {/* 5-Hour Usage Chart */}
        <Box flexDirection="column">
          <Box>
            <Text color="cyan" bold>5-Hour Usage</Text>
            <Text color="gray"> ({snapshots.length} snapshots, </Text>
            <Text color="gray">{formatTimeAgo(firstTime)} to now)</Text>
          </Box>

          <LineGraph
            data={[{ values: fiveHourData, color: 'cyan' }]}
            height={5}
            width={72}
            yDomain={[0, 100]}
            showYAxis
            yLabels={[0, 25, 50, 75, 100]}
          />

          <Box gap={2}>
            <Box>
              <Text color="gray">Current: </Text>
              <Text color="white">{Math.round(current5h)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Min: </Text>
              <Text color="green">{Math.round(min5h)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Max: </Text>
              <Text color="yellow">{Math.round(max5h)}%</Text>
            </Box>
          </Box>
        </Box>

        {/* 7-Day Usage Chart */}
        <Box flexDirection="column">
          <Box>
            <Text color="magenta" bold>7-Day Usage</Text>
          </Box>

          <LineGraph
            data={[{ values: sevenDayData, color: 'magenta' }]}
            height={5}
            width={72}
            yDomain={[0, 100]}
            showYAxis
            yLabels={[0, 25, 50, 75, 100]}
          />

          <Box gap={2}>
            <Box>
              <Text color="gray">Current: </Text>
              <Text color="white">{Math.round(current7d)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Min: </Text>
              <Text color="green">{Math.round(min7d)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Max: </Text>
              <Text color="yellow">{Math.round(max7d)}%</Text>
            </Box>
          </Box>
        </Box>

        {/* 5-Hour Trajectory Forecast */}
        {hasForecast5h && (
          <Box flexDirection="column">
            <Box>
              <Text color="cyan" bold>5-Hour Forecast</Text>
              <Text color="gray"> (history → projection)</Text>
            </Box>

            <LineGraph
              data={[
                { values: combined5h, color: 'cyan' },
                { values: targetLine5h, color: 'gray' },
              ]}
              height={5}
              width={72}
              yDomain={[0, 100]}
              showYAxis
              yLabels={[0, 25, 50, 75, 100]}
              xLabels={forecastXLabels}
            />

            <Box gap={2}>
              <Text color="cyan">━ 5h usage</Text>
              <Text color="gray">━ 90% target</Text>
              <Text color="gray">  │  left: history  │  right: projected</Text>
            </Box>
          </Box>
        )}

        {/* 7-Day Trajectory Forecast */}
        {hasForecast7d && (
          <Box flexDirection="column">
            <Box>
              <Text color="magenta" bold>7-Day Forecast</Text>
              <Text color="gray"> (history → projection)</Text>
            </Box>

            <LineGraph
              data={[
                { values: combined7d, color: 'magenta' },
                { values: targetLine7d, color: 'gray' },
              ]}
              height={5}
              width={72}
              yDomain={[0, 100]}
              showYAxis
              yLabels={[0, 25, 50, 75, 100]}
              xLabels={forecastXLabels}
            />

            <Box gap={2}>
              <Text color="magenta">━ 7d usage</Text>
              <Text color="gray">━ 90% target</Text>
              <Text color="gray">  │  left: history  │  right: projected</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Section>
  );
}
