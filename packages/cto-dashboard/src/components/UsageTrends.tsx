/**
 * Usage Trends Component
 *
 * Displays historical line graphs for 5-hour and 7-day usage.
 * Uses @pppp606/ink-chart LineGraph for high-resolution rendering.
 * Only shows actual historical data (no projections on graph).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { LineGraph } from '@pppp606/ink-chart';
import { Section } from './Section.js';
import type { UsageSnapshot } from '../utils/trajectory.js';

export interface UsageTrendsProps {
  snapshots: UsageSnapshot[];
  hasData: boolean;
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

export function UsageTrends({ snapshots, hasData }: UsageTrendsProps): React.ReactElement | null {
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

  return (
    <Section title="USAGE TRENDS" borderColor="blue" width="100%">
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
      </Box>
    </Section>
  );
}
