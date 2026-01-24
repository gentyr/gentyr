/**
 * Usage Trajectory Component
 *
 * Displays usage projections: current %, projected at reset, time to reset, trend rate.
 * Side-by-side display for 5-hour and 7-day windows.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { TrajectoryResult } from '../utils/trajectory.js';

export interface UsageTrajectoryProps {
  trajectory: TrajectoryResult;
}

/**
 * Format duration until reset
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
 * Format trend with arrow indicator
 */
function formatTrend(trendPerUnit: number | null, unit: string): { text: string; color: string } {
  if (trendPerUnit === null) {
    return { text: 'N/A', color: 'gray' };
  }

  const absValue = Math.abs(trendPerUnit);
  const sign = trendPerUnit >= 0 ? '+' : '';
  const arrow = trendPerUnit > 0.1 ? '↑' : trendPerUnit < -0.1 ? '↓' : '→';

  // Color based on trend direction (higher usage = more yellow/red)
  let color = 'gray';
  if (trendPerUnit > 1) color = 'red';
  else if (trendPerUnit > 0.5) color = 'yellow';
  else if (trendPerUnit < -0.5) color = 'green';
  else if (trendPerUnit < 0) color = 'cyan';

  return {
    text: `${sign}${absValue.toFixed(1)}%/${unit} ${arrow}`,
    color,
  };
}

/**
 * Format projected value with indicator
 */
function formatProjected(current: number, projected: number | null): { text: string; arrow: string; color: string } {
  if (projected === null) {
    return { text: 'N/A', arrow: '', color: 'gray' };
  }

  const rounded = Math.round(projected);
  const arrow = projected > current + 1 ? ' ↑' : projected < current - 1 ? ' ↓' : '';

  // Color based on projected value
  let color = 'green';
  if (rounded >= 95) color = 'red';
  else if (rounded >= 85) color = 'yellow';
  else if (rounded >= 70) color = 'cyan';

  return {
    text: `${rounded}%`,
    arrow,
    color,
  };
}

interface WindowCardProps {
  title: string;
  titleColor: string;
  current: number;
  projected: number | null;
  resetTime: Date | null;
  trendPerHour: number | null;
  trendUnit: string;
}

function WindowCard({
  title,
  titleColor,
  current,
  projected,
  resetTime,
  trendPerHour,
  trendUnit,
}: WindowCardProps): React.ReactElement {
  const projectedInfo = formatProjected(current, projected);
  const trendInfo = formatTrend(trendPerHour, trendUnit);

  return (
    <Box flexDirection="column" width={32}>
      <Text color={titleColor} bold>{title}</Text>
      <Box marginLeft={1} flexDirection="column">
        <Box>
          <Text color="gray">├─ Current:     </Text>
          <Text color="white">{Math.round(current)}%</Text>
        </Box>
        <Box>
          <Text color="gray">├─ At Reset:    </Text>
          <Text color={projectedInfo.color}>{projectedInfo.text}</Text>
          <Text color={projectedInfo.color}>{projectedInfo.arrow}</Text>
        </Box>
        <Box>
          <Text color="gray">├─ Reset In:    </Text>
          <Text color="cyan">{formatTimeUntil(resetTime)}</Text>
        </Box>
        <Box>
          <Text color="gray">└─ Trend:       </Text>
          <Text color={trendInfo.color}>{trendInfo.text}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function UsageTrajectory({ trajectory }: UsageTrajectoryProps): React.ReactElement | null {
  if (!trajectory.hasData || trajectory.snapshots.length === 0) {
    return null;
  }

  // Get current values from latest snapshot
  const latest = trajectory.snapshots[trajectory.snapshots.length - 1];
  const current5h = latest.fiveHour;
  const current7d = latest.sevenDay;

  return (
    <Section title="USAGE TRAJECTORY" borderColor="yellow">
      <Box flexDirection="column">
        {/* Side-by-side windows */}
        <Box flexDirection="row" gap={4}>
          <WindowCard
            title="5-Hour Window"
            titleColor="cyan"
            current={current5h}
            projected={trajectory.fiveHourProjectedAtReset}
            resetTime={trajectory.fiveHourResetTime}
            trendPerHour={trajectory.fiveHourTrendPerHour}
            trendUnit="hr"
          />

          <WindowCard
            title="7-Day Window"
            titleColor="magenta"
            current={current7d}
            projected={trajectory.sevenDayProjectedAtReset}
            resetTime={trajectory.sevenDayResetTime}
            trendPerHour={trajectory.sevenDayTrendPerDay}
            trendUnit="day"
          />
        </Box>

        {/* Footer with projection method */}
        <Box marginTop={1}>
          <Text color="gray">Projection Method: Linear regression on last {Math.min(30, trajectory.snapshots.length)} snapshots</Text>
        </Box>
      </Box>
    </Section>
  );
}
